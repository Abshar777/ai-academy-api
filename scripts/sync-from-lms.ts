/**
 * Pulls new and changed lesson videos out of the LMS and into `ai_academy`.
 *
 * The import (import-content.ts) builds the course from scratch out of two JSON
 * exports. This is the thing you run afterwards, whenever a recording is
 * re-uploaded or a missing Malayalam track finally lands: it reads the LMS
 * database directly, pairs it with the same rules the import uses, and writes
 * only the `media` entries that actually differ.
 *
 *   bun run scripts/sync-from-lms.ts            # dry run — reports, writes nothing
 *   bun run scripts/sync-from-lms.ts --write
 *
 * Deliberately narrow: it syncs video files and their durations, nothing else.
 * A brand-new episode, a renamed lesson or a re-ordered module changes the
 * shape of the course, and rebuilding that shape correctly — order, free
 * episodes, pruning what no longer exists — is the import's job. Those show up
 * in the report with the command to run, rather than being half-applied here.
 *
 * Two checks stand in front of every write:
 *
 *   · the duration is probed from the file itself, because the LMS's
 *     durationMins is wrong often enough to be worthless (a 25-minute episode
 *     filed as 1 minute);
 *   · the audio is correlated against the episode's other language, because
 *     the single most common mistake in this catalogue is the English
 *     recording being uploaded into the Malayalam slot. Five of those were
 *     caught during the original import. Anything scoring above 0.9 is refused.
 */

import { MongoClient, ObjectId, type Db } from "mongodb";
import { getDb, closeDb } from "../src/db.ts";
import {
  COURSES,
  MODULES,
  EPISODES,
  LANGS,
  type Course,
  type Episode,
  type Lang,
  type Media,
  type Module,
} from "../src/content/types.ts";
import { pairCourses, type SourceExport, type SourceLesson } from "./pairing.ts";
import { NEEDS_AN_EAR, SAME_RECORDING, compare } from "./audio.ts";
import { isR2Configured, playbackUrl } from "../src/media/r2.ts";

const COURSE_SLUG = "ai-academy";
const CACHE_PATH = new URL("../.cache/durations.json", import.meta.url).pathname;
const CONCURRENCY = 4;

// ---------------------------------------------------------------- arguments

function arg(name: string): string | undefined {
  const i = Bun.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : Bun.argv[i + 1];
}

const WRITE = Bun.argv.includes("--write");
/** Skips the duplicate-recording check. For a quick look at what changed —
 *  not for a --write run, where it removes the only guard against filing the
 *  English video as Malayalam. */
const SKIP_AUDIO = Bun.argv.includes("--skip-audio");
/** Writes files the audio check flagged anyway, once someone has listened. */
const TRUST_IDENTICAL = Bun.argv.includes("--trust-identical");
/** Also print the episodes that are already up to date. */
const SHOW_ALL = Bun.argv.includes("--all");

const LMS_DB = arg("lms-db") ?? "lms";
const EN_SLUG = arg("en-slug") ?? "ai-academy-english";
const ML_SLUG = arg("ml-slug") ?? "ai";

// ------------------------------------------------------------- the LMS side

/**
 * Reads one LMS course into the shape the pairing expects — the same shape the
 * LMS's own `export-course.ts` writes, so nothing downstream can tell whether
 * it came from a file or straight off the cluster.
 */
async function loadCourse(lms: Db, slug: string, label: string): Promise<SourceExport> {
  const course = await lms.collection("courses").findOne({ slug });
  if (!course) {
    const candidates = await lms
      .collection("courses")
      .find({ program: "ai" })
      .project({ slug: 1, title: 1 })
      .toArray();
    const list = candidates.map((c) => `${c.slug} (${c.title})`).join(", ") || "none";
    throw new Error(
      `${label} course "${slug}" is not in the ${lms.databaseName} database.\n` +
        `  Courses in the "ai" programme: ${list}\n` +
        `  Pass --${label === "English" ? "en" : "ml"}-slug to point at a different one.`,
    );
  }

  const [sections, lessons] = await Promise.all([
    lms.collection("sections").find({ courseId: course._id }).sort({ order: 1 }).toArray(),
    lms.collection("lessons").find({ courseId: course._id }).sort({ order: 1 }).toArray(),
  ]);

  // String comparison rather than ObjectId equality: the LMS has written both
  // over the years and its own export script compares this way too.
  const lessonsOf = (sectionId: unknown): SourceLesson[] =>
    lessons
      .filter((l) => String(l.sectionId) === String(sectionId))
      .map((l) => ({
        _id: String(l._id),
        title: String(l.title ?? ""),
        contentUrl: typeof l.contentUrl === "string" && l.contentUrl ? l.contentUrl : undefined,
        durationMins: typeof l.durationMins === "number" ? l.durationMins : undefined,
        order: Number(l.order ?? 0),
      }));

  return {
    course: {
      title: String(course.title ?? slug),
      slug: String(course.slug ?? slug),
      description: typeof course.description === "string" ? course.description : undefined,
    },
    sections: sections.map((s) => ({
      _id: String(s._id),
      title: String(s.title ?? ""),
      order: Number(s.order ?? 0),
      lessons: lessonsOf(s._id),
    })),
  };
}

// ---------------------------------------------------------------- durations

/**
 * Reads the real runtime out of the file's container. The bucket is served
 * through presigned URLs, so the URL is signed first — ffprobe fetches only the
 * header it needs, not the whole video.
 */
async function probeDuration(url: string): Promise<number | null> {
  const signed = await playbackUrl(url);
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration",
     "-of", "default=noprint_wrappers=1:nokey=1", "-i", signed],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (proc.exitCode !== 0) return null;
  const seconds = Number.parseFloat(out.trim());
  return Number.isFinite(seconds) ? Math.round(seconds) : null;
}

// -------------------------------------------------------------- the diffing

type State = "new" | "changed";

type Candidate = {
  moduleOrder: number;
  key: string;
  title: string;
  lang: Lang;
  state: State;
  /** The LMS file this would adopt. */
  url: string;
  /** What we have now, when this is a replacement. */
  previousUrl?: string;
  episodeId: ObjectId;
  /** The other language's file as it will stand once this sync is applied —
   *  what the audio check compares against. Absent when the episode is
   *  single-language, and then there is nothing to compare and nothing to get
   *  wrong. */
  counterpart?: string;
  durationSec?: number;
  /** NaN when there was no counterpart or the audio wouldn't decode. */
  r?: number;
  /** Set when a check refuses this write, with the reason. */
  blocked?: string;
};

function pad(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

function minutes(seconds: number | undefined): string {
  if (seconds === undefined) return "  —  ";
  return `${String(Math.floor(seconds / 60)).padStart(3)}:${String(seconds % 60).padStart(2, "0")}`;
}

// --------------------------------------------------------------------- main

async function main() {
  const uri = process.env.LMS_MONGODB_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  const lmsClient = new MongoClient(uri);
  await lmsClient.connect();
  const lms = lmsClient.db(LMS_DB);

  const [enSource, mlSource] = await Promise.all([
    loadCourse(lms, EN_SLUG, "English"),
    loadCourse(lms, ML_SLUG, "Malayalam"),
  ]);
  await lmsClient.close();

  const lessonCount = (s: SourceExport) => s.sections.reduce((n, x) => n + x.lessons.length, 0);
  console.log(`\n  From ${LMS_DB}:`);
  console.log(`    English   ${enSource.course.title}  (${lessonCount(enSource)} lessons)`);
  console.log(`    Malayalam ${mlSource.course.title}  (${lessonCount(mlSource)} lessons)`);

  const { modules: paired, dropped } = pairCourses(enSource, mlSource);

  // ------------------------------------------------------------- our side
  const db = await getDb();
  const course = await db.collection<Course>(COURSES).findOne({ slug: COURSE_SLUG });
  if (!course?._id) throw new Error(`No "${COURSE_SLUG}" course in ${db.databaseName} — run import:content first`);

  const ourModules = await db
    .collection<Module>(MODULES)
    .find({ courseId: course._id })
    .sort({ order: 1 })
    .toArray();
  const ourEpisodes = await db.collection<Episode>(EPISODES).find({ courseId: course._id }).toArray();

  const orderOfModule = new Map(ourModules.map((m) => [m._id!.toHexString(), m.order]));
  const ours = new Map<string, Episode>();
  for (const episode of ourEpisodes) {
    const order = orderOfModule.get(episode.moduleId.toHexString());
    if (order !== undefined) ours.set(`${order}/${episode.key}`, episode);
  }
  console.log(`    against ${db.databaseName}: ${ourEpisodes.length} episodes in ${ourModules.length} modules\n`);

  // ------------------------------------------------------------- the diff
  const candidates: Candidate[] = [];
  const unchanged: string[] = [];
  /** We hold a file the LMS no longer offers — never deleted here, because it
   *  may well be the hand-placed one and the LMS the thing that regressed. */
  const orphaned: string[] = [];
  /** In the LMS, paired fine, but no episode of ours to put it on. */
  const structural: string[] = [];
  /** In the LMS and claimed by no pairing rule — the case that would otherwise
   *  pass in silence, so it is reported loudest. */
  const unclaimed: string[] = [];

  for (const module of paired) {
    for (const episode of module.paired) {
      const mine = ours.get(`${module.order}/${episode.key}`);
      if (!mine) {
        const langs = LANGS.filter((l) => episode.source[l]?.contentUrl).join("+") || "no video";
        structural.push(`M${module.order + 1} ${episode.key} "${episode.title.en}" (${langs})`);
        continue;
      }

      for (const lang of LANGS) {
        const url = episode.source[lang]?.contentUrl;
        const held = mine.media[lang]?.url;
        const where = `M${module.order + 1} ${episode.key} ${lang.toUpperCase()}`;

        if (!url) {
          if (held) orphaned.push(`${where} — we hold a file the LMS no longer lists`);
          continue;
        }
        if (url === held) {
          unchanged.push(`${where}  ${episode.title.en}`);
          continue;
        }
        candidates.push({
          moduleOrder: module.order,
          key: episode.key,
          title: episode.title.en,
          lang,
          state: held ? "changed" : "new",
          url,
          previousUrl: held,
          episodeId: mine._id!,
        });
      }
    }

    for (const item of module.unconsumed) {
      unclaimed.push(`M${module.order + 1} ${item.lang.toUpperCase()} "${item.title}"`);
    }
  }

  // Each candidate's counterpart is the other language as it will stand after
  // this sync — a newly uploaded pair is compared new-against-new, not against
  // whatever one of them is replacing.
  for (const candidate of candidates) {
    const other = LANGS.find((l) => l !== candidate.lang)!;
    const incoming = candidates.find(
      (c) => c.moduleOrder === candidate.moduleOrder && c.key === candidate.key && c.lang === other,
    );
    candidate.counterpart =
      incoming?.url ?? ours.get(`${candidate.moduleOrder}/${candidate.key}`)?.media[other]?.url;
  }

  if (!candidates.length) {
    report(unchanged, orphaned, structural, unclaimed, dropped, []);
    console.log(`  Nothing to sync — every video in the LMS is already the one we serve.\n`);
    await closeDb();
    return;
  }

  // -------------------------------------------------------------- the checks
  if (!isR2Configured()) {
    console.log(`  R2 is not configured — probing unsigned URLs, which only works while the bucket is public.\n`);
  }
  process.stdout.write(`  probing ${candidates.length} file${candidates.length === 1 ? "" : "s"}`);
  await inParallel(candidates, async (candidate) => {
    const seconds = await probeDuration(candidate.url);
    if (seconds === null) candidate.blocked = "the file would not open — wrong URL, or not uploaded yet";
    else candidate.durationSec = seconds;
    process.stdout.write(".");
  });
  process.stdout.write(" done\n");

  const toCompare = candidates.filter((c) => !c.blocked && c.counterpart);
  if (SKIP_AUDIO) {
    console.log(`  (--skip-audio: ${toCompare.length} duplicate-recording checks not run)\n`);
  } else if (toCompare.length) {
    process.stdout.write(`  comparing audio against the other language on ${toCompare.length}`);
    await inParallel(toCompare, async (candidate) => {
      const signed = await Promise.all([playbackUrl(candidate.url), playbackUrl(candidate.counterpart!)]);
      candidate.r = await compare(signed[0], signed[1]);
      process.stdout.write(".");
    });
    process.stdout.write(" done\n");

    for (const candidate of toCompare) {
      const r = candidate.r!;
      if (Number.isNaN(r)) continue; // nothing decoded — not evidence either way
      if (r > SAME_RECORDING) {
        candidate.blocked = TRUST_IDENTICAL
          ? undefined
          : `r=${r.toFixed(3)} — this is the same recording as the ${candidate.lang === "en" ? "Malayalam" : "English"} file`;
      } else if (r > NEEDS_AN_EAR) {
        candidate.blocked = TRUST_IDENTICAL
          ? undefined
          : `r=${r.toFixed(3)} — too close to call, listen to it first`;
      }
    }
  }
  console.log("");

  // -------------------------------------------------------------- the report
  const ready = candidates.filter((c) => !c.blocked);
  const blocked = candidates.filter((c) => c.blocked);

  console.log(`  TO SYNC`);
  console.log(`  ${"".padEnd(96, "─")}`);
  console.log(`  ${pad("EPISODE", 34)}${pad("LANG", 6)}${pad("STATE", 10)}${pad("LENGTH", 9)}${pad("r", 8)}VERDICT`);
  for (const c of [...ready, ...blocked]) {
    const r = c.r === undefined ? "—" : Number.isNaN(c.r) ? "n/a" : c.r.toFixed(3);
    console.log(
      `  ${pad(`M${c.moduleOrder + 1} ${c.key} ${c.title}`, 34)}${pad(c.lang.toUpperCase(), 6)}` +
        `${pad(c.state === "new" ? "NEW" : "replaces", 10)}${pad(minutes(c.durationSec), 9)}${pad(r, 8)}` +
        (c.blocked ? `REFUSED — ${c.blocked}` : "ok"),
    );
  }

  report(unchanged, orphaned, structural, unclaimed, dropped, blocked);

  console.log(`  ${ready.length} to write · ${blocked.length} refused · ${unchanged.length} already current\n`);

  if (!ready.length) {
    console.log(`  Nothing passed the checks, so nothing would be written.\n`);
    await closeDb();
    return;
  }
  if (!WRITE) {
    console.log(`  Dry run — nothing written. Re-run with --write to commit.\n`);
    await closeDb();
    return;
  }

  // --------------------------------------------------------------- the write
  const now = new Date();
  for (const c of ready) {
    // The whole media entry is replaced rather than merged: a streamUid left
    // over from the previous file would point Cloudflare Stream at a video
    // this episode no longer uses, and serve it.
    const media: Media = { url: c.url, durationSec: c.durationSec ?? 0 };
    await db
      .collection<Episode>(EPISODES)
      .updateOne({ _id: c.episodeId }, { $set: { [`media.${c.lang}`]: media, updatedAt: now } });
    console.log(`  wrote  M${c.moduleOrder + 1} ${c.key} ${c.lang.toUpperCase()}  ${minutes(c.durationSec)}`);
  }

  await cacheDurations(ready);
  console.log(`\n  ${ready.length} media entr${ready.length === 1 ? "y" : "ies"} updated in ${db.databaseName}.\n`);
  await closeDb();
}

/** The parts of the report that print whether or not anything changed. */
function report(
  unchanged: string[],
  orphaned: string[],
  structural: string[],
  unclaimed: string[],
  dropped: { title: string; reason: string }[],
  blocked: Candidate[],
) {
  console.log(`\n  ${"".padEnd(96, "═")}`);

  if (unclaimed.length) {
    console.log(`\n  NOT CLAIMED BY ANY PAIRING RULE — these are in the LMS and are being ignored`);
    for (const line of unclaimed) console.log(`    · ${line}`);
    console.log(`    Add an entry to ALIASES (or MODULE_3, or DROPPED) in scripts/pairing.ts to place them.`);
  }
  if (structural.length) {
    console.log(`\n  NEEDS THE FULL IMPORT — episodes the LMS has and this course doesn't`);
    for (const line of structural) console.log(`    · ${line}`);
    console.log(`    Adding one means re-numbering the module, so run import:content rather than this.`);
  }
  if (orphaned.length) {
    console.log(`\n  ONLY HERE — left alone, in case the LMS is what regressed`);
    for (const line of orphaned) console.log(`    · ${line}`);
  }
  if (blocked.length) {
    console.log(`\n  REFUSED`);
    for (const c of blocked) {
      console.log(`    · M${c.moduleOrder + 1} ${c.key} ${c.lang.toUpperCase()} — ${c.blocked}`);
    }
    console.log(`    Listen to the file. If it really is the right one, re-run with --trust-identical.`);
  }
  if (dropped.length) {
    console.log(`\n  ${dropped.length} known-duplicate Malayalam upload${dropped.length === 1 ? "" : "s"} set aside by pairing.ts, as always.`);
  }
  if (SHOW_ALL && unchanged.length) {
    console.log(`\n  ALREADY CURRENT`);
    for (const line of unchanged) console.log(`    · ${line}`);
  }
  console.log("");
}

/** Shares the import's duration cache, so a file probed here isn't probed
 *  again by a later import of the same catalogue. */
async function cacheDurations(written: Candidate[]): Promise<void> {
  const file = Bun.file(CACHE_PATH);
  const cache: Record<string, number> = (await file.exists()) ? await file.json() : {};
  for (const c of written) if (c.durationSec !== undefined) cache[c.url] = c.durationSec;
  await Bun.write(CACHE_PATH, JSON.stringify(cache, null, 2));
}

async function inParallel<T>(items: T[], run: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) await run(item);
    }),
  );
}

main().catch(async (err) => {
  console.error("\n  Sync failed:", err instanceof Error ? err.message : err, "\n");
  await closeDb();
  process.exit(1);
});
