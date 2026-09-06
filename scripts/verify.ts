/** Reads back what the import wrote, the way the course view will. */
import { getDb, closeDb } from "../src/db.ts";
import { COURSES, MODULES, EPISODES, type Course, type Episode, type Module } from "../src/content/types.ts";

const db = await getDb();
const course = await db.collection<Course>(COURSES).findOne({ slug: "ai-academy" });
if (!course?._id) throw new Error("course not found");

const modules = await db.collection<Module>(MODULES).find({ courseId: course._id }).sort({ order: 1 }).toArray();
console.log(`\n  ${course.title.en}  (${modules.length} modules)\n`);

let bilingual = 0, total = 0, seconds = 0;
for (const m of modules) {
  const eps = await db.collection<Episode>(EPISODES).find({ moduleId: m._id }).sort({ order: 1 }).toArray();
  console.log(`  ${m.order + 1}. ${m.title.en}  — ${eps.length} episodes`);
  for (const e of eps) {
    total++;
    const langs = Object.keys(e.media);
    if (langs.length === 2) bilingual++;
    seconds += e.media.en?.durationSec ?? e.media.ml?.durationSec ?? 0;
  }
}
const dupes = await db.collection<Episode>(EPISODES).aggregate([
  { $group: { _id: { m: "$moduleId", k: "$key" }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
]).toArray();

console.log(`\n  ${total} episodes · ${bilingual} with both languages · ${Math.round(seconds / 60)} min of English runtime`);
console.log(`  duplicate (module, key) pairs after two runs: ${dupes.length}\n`);
await closeDb();
