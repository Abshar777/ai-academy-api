/**
 * Reads back every episode the import wrote and checks that an episode claiming
 * two languages really has two recordings.
 *
 * The test itself lives in audio.ts — the sync runs the same one as a gate
 * before it writes anything, so the two can't disagree.
 */
import { getDb, closeDb } from "../src/db.ts";
import { COURSES, MODULES, EPISODES, type Course, type Episode, type Module } from "../src/content/types.ts";
import { AUDIO_SECONDS, NEEDS_AN_EAR, SAME_RECORDING, compare, verdictFor } from "./audio.ts";
import { playbackUrl } from "../src/media/r2.ts";

const CONCURRENCY = 4;

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
console.log(`  Comparing ${AUDIO_SECONDS}s of audio per file.\n`);
console.log("  " + "EPISODE".padEnd(54) + "r".padStart(7) + "   VERDICT");
console.log("  " + "".padEnd(86, "─"));

const results: { label: string; r: number }[] = [];
const queue = [...jobs];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      // Signed, because the bucket is private — handing ffmpeg the stored URL
      // gets a 401 and a decode failure that looks like a content problem.
      const [en, ml] = await Promise.all([playbackUrl(job.en), playbackUrl(job.ml)]);
      results.push({ label: job.label, r: await compare(en, ml) });
    }
  }),
);

results.sort((x, y) => y.r - x.r);
let bad = 0, unsure = 0, failed = 0;
for (const { label, r } of results) {
  const verdict = verdictFor(r);
  if (Number.isNaN(r)) failed++;
  else if (r > SAME_RECORDING) bad++;
  else if (r > NEEDS_AN_EAR) unsure++;
  console.log(`  ${label.padEnd(54)}${Number.isNaN(r) ? "—".padStart(7) : r.toFixed(3).padStart(7)}   ${verdict}`);
}

console.log(
  `\n  ${results.length - bad - unsure - failed} genuinely bilingual · ${unsure} unclear · ` +
    `${bad} same-recording · ${failed} could not be read\n`,
);
await closeDb();
// A file that wouldn't decode was not checked, so this run proves nothing about
// it — exiting 0 here is how a broken check passes for weeks unnoticed.
if (bad || unsure || failed) process.exit(1);
