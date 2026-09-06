/**
 * Do the "_bgm-only" files actually contain narration?
 *
 * The name reads as "background music only", which would make them useless as a
 * Malayalam track no matter how different they are from the English. Speech
 * pauses constantly — a narrated take spends a good fraction of its time near
 * silence — while continuous music does not, so the share of quiet frames
 * separates the two clearly. Known narrated files are measured alongside as a
 * reference point.
 */
const SECONDS = 120, RATE = 8000, WINDOW = RATE / 20; // 50ms frames

async function frames(url: string): Promise<Float64Array | null> {
  const p = Bun.spawn(["ffmpeg", "-v", "error", "-i", url, "-t", String(SECONDS),
    "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"], { stdout: "pipe", stderr: "pipe" });
  const [buf] = await Promise.all([new Response(p.stdout).arrayBuffer(), p.exited]);
  if (p.exitCode !== 0 || buf.byteLength === 0) return null;
  const pcm = new Int16Array(buf);
  const out = new Float64Array(Math.floor(pcm.length / WINDOW));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let j = i * WINDOW; j < (i + 1) * WINDOW; j++) s += pcm[j]! ** 2;
    out[i] = Math.sqrt(s / WINDOW);
  }
  return out;
}

const ml = await Bun.file(Bun.argv[3]!).json();
const en = await Bun.file(Bun.argv[2]!).json();
const mods = (s: any) => [...s.sections].sort((a: any, b: any) => a.order - b.order)
  .map((x: any) => [...x.lessons].sort((a: any, b: any) => a.order - b.order));
const enM = mods(en), mlM = mods(ml);
const url = (m: any[], t: string) => m.find((l: any) => l.title === t)?.contentUrl as string | undefined;

const CASES: { label: string; url?: string }[] = [
  { label: "reference  EN narrated   M1 ep-1", url: url(enM[0]!, "ep-1 , What is AI + How AI Works") },
  { label: "reference  ML narrated   M1 ep-1", url: url(mlM[0]!, "ep-1 , what is AI + How AI works") },
  { label: "reference  ML narrated   M2 ep-1", url: url(mlM[1]!, "ep-1 , typical ai designs") },
  { label: "IN USE     ML ep-6  landing-page_bgm-only", url: url(mlM[1]!, "landing-page-malayalam_bgm-only") },
  { label: "CANDIDATE  ML ep-7  portfolio_bgm-only", url: url(mlM[1]!, "portfolio-malayalam_bgm-only") },
  { label: "CANDIDATE  ML ep-4  claude-ai[malayalam]", url: url(mlM[1]!, "claude-ai[malayalam] (1)") },
  { label: "IN USE     ML M3    ai-designs_bgm-only", url: url(mlM[2]!, "ai-designs-malayalam_bgm-only") },
];

console.log(`\n  Quiet-frame share over ${SECONDS}s. Narration pauses; continuous music doesn't.\n`);
console.log("  " + "FILE".padEnd(44) + "QUIET".padStart(7) + "  PEAK".padStart(8) + "   READS AS");
console.log("  " + "".padEnd(80, "─"));
for (const c of CASES) {
  if (!c.url) { console.log(`  ${c.label.padEnd(44)}${"—".padStart(7)}`); continue; }
  const f = await frames(c.url);
  if (!f) { console.log(`  ${c.label.padEnd(44)}${"—".padStart(7)}   decode failed`); continue; }
  const peak = Math.max(...f);
  // "Quiet" relative to the file's own peak, so overall mastering level doesn't skew it.
  const quiet = f.filter((v) => v < peak * 0.06).length / f.length;
  const reads = quiet > 0.12 ? "narration" : quiet > 0.04 ? "borderline" : "continuous audio — likely music only";
  console.log(`  ${c.label.padEnd(44)}${(quiet * 100).toFixed(1).padStart(6)}%${peak.toFixed(0).padStart(8)}   ${reads}`);
}
console.log();
