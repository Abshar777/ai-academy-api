/**
 * Reads back every episode the import wrote and checks that an episode claiming
 * two languages really has two recordings.
 *
 * Correlating the loudness envelopes of the two audio tracks separates them
 * cleanly: two encodes of one take score ~1.0, the same screencast narrated
 * twice scores below 0.2. Anything in between is worth a human ear.
 */
import { getDb, closeDb } from "../src/db.ts";
import { COURSES, MODULES, EPISODES, type Course, type Episode, type Module } from "../src/content/types.ts";

const SECONDS = 60;
const RATE = 8000;
const WINDOW = RATE / 10;
const CONCURRENCY = 4;

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

const db = await getDb();
const course = await db.collection<Course>(COURSES).findOne({ slug: "ai-academy" });
if (!course?._id) throw new Error("course not found — run the import first");
const modules = await db.collection<Module>(MODULES).find({ courseId: course._id }).sort({ order: 1 }).toArray();

type Job = { label: string; en: string; ml: string };
const jobs: Job[] = [];
let single = 0;
for (const m of modules) {
  const eps = await db.collection<Episode>(EPISODES).find({ moduleId: m._id }).sort({ order: 1 }).toArray();
  for (const e of eps) {
    if (e.media.en && e.media.ml) {
      jobs.push({ label: `M${m.order + 1} ${e.key}  ${e.title.en}`.slice(0, 52), en: e.media.en.url, ml: e.media.ml.url });
    } else single++;
  }
}

console.log(`\n  ${jobs.length} bilingual episodes to check (${single} single-language, skipped)`);
console.log(`  Comparing ${SECONDS}s of audio per file.\n`);
console.log("  " + "EPISODE".padEnd(54) + "r".padStart(7) + "   VERDICT");
console.log("  " + "".padEnd(86, "─"));

const results: { label: string; r: number }[] = [];
const queue = [...jobs];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const [a, b] = await Promise.all([envelope(job.en), envelope(job.ml)]);
      results.push({ label: job.label, r: a && b ? correlate(a, b) : NaN });
    }
  }),
);

results.sort((x, y) => y.r - x.r);
let bad = 0, unsure = 0;
for (const { label, r } of results) {
  const verdict = Number.isNaN(r) ? "decode failed"
    : r > 0.9 ? "SAME RECORDING — not bilingual"
    : r > 0.4 ? "unclear — needs an ear"
    : "two recordings, good";
  if (r > 0.9) bad++;
  else if (r > 0.4) unsure++;
  console.log(`  ${label.padEnd(54)}${Number.isNaN(r) ? "—".padStart(7) : r.toFixed(3).padStart(7)}   ${verdict}`);
}

console.log(`\n  ${results.length - bad - unsure} genuinely bilingual · ${unsure} unclear · ${bad} same-recording\n`);
await closeDb();
