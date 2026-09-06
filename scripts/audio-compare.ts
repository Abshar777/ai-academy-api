/**
 * Answers the question the runtimes only hinted at: is a Malayalam file
 * actually a different recording, or the English one filed twice?
 *
 * Compares the loudness envelope of the two audio tracks. Speech drives volume
 * up and down in a pattern that is effectively a fingerprint of a take, and it
 * survives re-encoding — so two encodes of the same recording correlate near
 * 1.0, while the same screencast narrated twice does not. Runs against known
 * pairs at both extremes as controls, so the numbers can be read in context.
 */

const SECONDS = 90;
const RATE = 8000;
/** 100ms windows — long enough to smooth out waveform phase, short enough to
 *  track the rhythm of speech. */
const WINDOW = RATE / 10;

async function envelope(url: string): Promise<Float64Array | null> {
  const proc = Bun.spawn(
    ["ffmpeg", "-v", "error", "-i", url, "-t", String(SECONDS),
     "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [buf] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
  if (proc.exitCode !== 0 || buf.byteLength === 0) return null;

  const pcm = new Int16Array(buf);
  const out = new Float64Array(Math.floor(pcm.length / WINDOW));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let j = i * WINDOW; j < (i + 1) * WINDOW; j++) sum += pcm[j]! ** 2;
    out[i] = Math.sqrt(sum / WINDOW);
  }
  return out;
}

function correlate(a: Float64Array, b: Float64Array): number {
  const n = Math.min(a.length, b.length);
  if (n < 10) return NaN;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]!; mb += b[i]!; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma, y = b[i]! - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / Math.sqrt(da * db);
}

const en = await Bun.file(Bun.argv[2]!).json();
const ml = await Bun.file(Bun.argv[3]!).json();
const mods = (s: any) => [...s.sections].sort((a: any, b: any) => a.order - b.order)
  .map((x: any) => [...x.lessons].sort((a: any, b: any) => a.order - b.order));
const enM = mods(en), mlM = mods(ml);
const find = (m: any[], t: string) => m.find((l: any) => l.title === t)?.contentUrl as string | undefined;

const CASES: { label: string; a?: string; b?: string; expect: string }[] = [
  // Controls first, so the suspect numbers can be read against known answers.
  { label: "CONTROL same file twice   M2 ep-1 ML vs its duplicate",
    a: find(mlM[1]!, "ep-1 , typical ai designs"), b: find(mlM[1]!, "ep1 , typical ai designs[Malayalam]"),
    expect: "known duplicate → expect ~1.0" },
  { label: "CONTROL real EN/ML pair   M1 ep-1",
    a: find(enM[0]!, "ep-1 , What is AI + How AI Works"), b: find(mlM[0]!, "ep-1 , what is AI + How AI works"),
    expect: "known different → expect low" },
  { label: "CONTROL real EN/ML pair   M4 ep-3",
    a: find(enM[3]!, "ep-3 , mobile application building"), b: find(mlM[3]!, "ep-3 , mobile application building"),
    expect: "known different → expect low" },

  { label: "SUSPECT M2 ep-2  Find Design Reference",
    a: find(enM[1]!, "ep-2 , Find Design Reference"), b: find(mlM[1]!, "ep-2 , design reference"), expect: "?" },
  { label: "SUSPECT M2 ep-4  Claude Explanation",
    a: find(enM[1]!, "ep-4 , Claude Explanation"), b: find(mlM[1]!, "ep-4 , claude code setup"), expect: "?" },
  { label: "SUSPECT M2 ep-5  Skill And Cammands",
    a: find(enM[1]!, "ep-5 , Skill And Cammands"), b: find(mlM[1]!, "ep-5 , skills and commands"), expect: "?" },
  { label: "SUSPECT M2 ep-7  Portfolio Website",
    a: find(enM[1]!, "ep-7 ,  Building a Portfolio Website"), b: find(mlM[1]!, "ep-7 , Building a Portfolio Website"), expect: "?" },
  { label: "SUSPECT M2 ep-9  Vercel Hosting",
    a: find(enM[1]!, "ep-9 , Vercel Portfolio Hosting"), b: find(mlM[1]!, "ep-9 , vercel portfolio hosting"), expect: "?" },

  { label: "ALT     M2 ep-4  EN vs claude-ai[malayalam]",
    a: find(enM[1]!, "ep-4 , Claude Explanation"), b: find(mlM[1]!, "claude-ai[malayalam] (1)"), expect: "?" },
  { label: "ALT     M2 ep-7  EN vs portfolio-malayalam",
    a: find(enM[1]!, "ep-7 ,  Building a Portfolio Website"), b: find(mlM[1]!, "portfolio-malayalam_bgm-only"), expect: "?" },
];

console.log(`\n  Comparing ${SECONDS}s of audio from each file.\n`);
console.log("  " + "COMPARISON".padEnd(46) + "r".padStart(7) + "   VERDICT");
console.log("  " + "".padEnd(80, "─"));

for (const c of CASES) {
  if (!c.a || !c.b) { console.log(`  ${c.label.padEnd(46)}${"—".padStart(7)}   file missing`); continue; }
  const [ea, eb] = await Promise.all([envelope(c.a), envelope(c.b)]);
  if (!ea || !eb) { console.log(`  ${c.label.padEnd(46)}${"—".padStart(7)}   decode failed`); continue; }
  const r = correlate(ea, eb);
  const verdict = r > 0.9 ? "SAME RECORDING" : r > 0.6 ? "similar — inspect" : "different recordings";
  console.log(`  ${c.label.padEnd(46)}${r.toFixed(3).padStart(7)}   ${verdict}${c.expect !== "?" ? `   (${c.expect})` : ""}`);
}
console.log();
