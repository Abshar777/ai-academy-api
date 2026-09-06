/**
 * Folds the two exported LMS courses — "Ai Academy English" and "AI Academy -
 * Malayalam" — into one bilingual course in the `ai_academy` database.
 *
 * Dry run by default: it prints exactly what it would write and touches
 * nothing. Pass --write once the pairing report reads correctly.
 *
 *   bun run scripts/import-content.ts --en <path> --ml <path>
 *   bun run scripts/import-content.ts --en <path> --ml <path> --write
 *
 * The exports are read from wherever they live and never copied into this
 * repo: their `_meta.source` is the source cluster's connection string,
 * credentials included.
 */

import { ObjectId } from "mongodb";
import { getDb, closeDb } from "../src/db.ts";
import {
  COURSES,
  MODULES,
  EPISODES,
  type Course,
  type Episode,
  type Lang,
  type Media,
  type Module,
} from "../src/content/types.ts";
import {
  ALIASES,
  DROPPED,
  FREE_EPISODES,
  MODULE_3,
  MODULE_TITLES,
  UNCLAIMED,
  cleanTitle,
  episodeNumber,
  looksLikeFilename,
} from "./pairing.ts";

const COURSE_SLUG = "ai-academy";
const CACHE_PATH = new URL("../.cache/durations.json", import.meta.url).pathname;

type SourceLesson = {
  _id: string;
  title: string;
  contentUrl?: string;
  durationMins?: number;
  order: number;
};

type SourceSection = { _id: string; title: string; order: number; lessons: SourceLesson[] };

type SourceExport = {
  course: { title: string; slug: string; description?: string };
  sections: SourceSection[];
};

/** An episode after pairing, before it becomes a database document. */
type Paired = {
  key: string;
  order: number;
  title: { en: string; ml?: string };
  source: Partial<Record<Lang, SourceLesson>>;
  notes: string[];
  /** Set during the report pass: the Malayalam file is almost certainly the
   *  English one, so it is not written unless --trust-identical is given. */
  suspectMl?: boolean;
};

// ---------------------------------------------------------------- arguments

function arg(name: string): string | undefined {
  const i = Bun.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : Bun.argv[i + 1];
}

const WRITE = Bun.argv.includes("--write");
const SKIP_PROBE = Bun.argv.includes("--skip-probe");
/**
 * Five Malayalam lessons in module 2 run to exactly the English runtime, to the
 * second, on separate files — the signature of the English video having been
 * uploaded into the Malayalam slot. They're withheld by default, so the toggle
 * says "English only" rather than quietly playing English under a Malayalam
 * label. Pass --trust-identical once someone has listened and confirmed.
 */
const TRUST_IDENTICAL = Bun.argv.includes("--trust-identical");

// ------------------------------------------------------------------ loading

async function loadExport(path: string, label: string): Promise<SourceExport> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`${label} export not found at ${path}`);
  const data = (await file.json()) as SourceExport;
  if (!Array.isArray(data.sections)) throw new Error(`${label} export has no sections array`);
  return data;
}

function sortedSections(source: SourceExport): SourceSection[] {
  return [...source.sections]
    .sort((a, b) => a.order - b.order)
    .map((section) => ({ ...section, lessons: [...section.lessons].sort((a, b) => a.order - b.order) }));
}

// ------------------------------------------------------------------ pairing

const droppedTitles = new Map(DROPPED.map((d) => [d.title, d.reason]));

/**
 * Modules 1, 2 and 4: both sides number their lessons, so the number is the
 * pairing key. Aliases redirect the handful of Malayalam lessons that belong to
 * a numbered episode but were filed under a working filename.
 */
function pairByNumber(
  moduleOrder: number,
  en: SourceLesson[],
  ml: SourceLesson[],
): { paired: Paired[]; unconsumed: { lang: Lang; title: string }[] } {
  const aliases = new Map(
    ALIASES.filter((a) => a.moduleOrder === moduleOrder).map((a) => [a.title, a.key]),
  );

  const byKey = new Map<string, Paired>();
  const unconsumed: { lang: Lang; title: string }[] = [];

  const place = (lang: Lang, lesson: SourceLesson) => {
    const aliased = aliases.get(lesson.title);
    const number = episodeNumber(lesson.title);
    const key = aliased ?? (number === null ? null : `ep-${number}`);

    if (!key) {
      unconsumed.push({ lang, title: lesson.title });
      return;
    }

    let entry = byKey.get(key);
    if (!entry) {
      entry = { key, order: 0, title: { en: "" }, source: {}, notes: [] };
      byKey.set(key, entry);
    }
    // First lesson to claim a key wins; a second is a duplicate the DROPPED
    // list should have caught, so it's surfaced rather than silently ignored.
    if (entry.source[lang]) {
      unconsumed.push({ lang, title: lesson.title });
      return;
    }
    entry.source[lang] = lesson;
    if (aliased) entry.notes.push(`Malayalam filed as "${lesson.title}"`);
  };

  for (const lesson of en) place("en", lesson);
  for (const lesson of ml) place("ml", lesson);

  const paired = [...byKey.values()].sort(
    (a, b) => Number(a.key.slice(3)) - Number(b.key.slice(3)),
  );
  paired.forEach((entry, i) => {
    entry.order = i;
    const enTitle = entry.source.en ? cleanTitle(entry.source.en.title) : "";
    const mlTitle = entry.source.ml ? cleanTitle(entry.source.ml.title) : "";
    entry.title.en = enTitle || mlTitle;
    if (mlTitle && !looksLikeFilename(mlTitle)) entry.title.ml = mlTitle;
    else if (mlTitle) entry.notes.push("Malayalam title is a filename — using the English title");
  });

  return { paired, unconsumed };
}

/**
 * Module 3: neither side numbers anything, so the pairing comes from the map in
 * pairing.ts, matched on exact source titles. Any lesson the map doesn't name is
 * reported — the map is not allowed to drop content quietly.
 */
function pairByTopic(
  en: SourceLesson[],
  ml: SourceLesson[],
): { paired: Paired[]; unconsumed: { lang: Lang; title: string }[] } {
  const enByTitle = new Map(en.map((l) => [l.title, l]));
  const mlByTitle = new Map(ml.map((l) => [l.title, l]));
  const seen = { en: new Set<string>(), ml: new Set<string>() };

  const paired: Paired[] = MODULE_3.map((topic, i) => {
    const entry: Paired = {
      key: topic.key,
      order: i,
      title: { en: topic.title },
      source: {},
      notes: [],
    };

    for (const lang of ["en", "ml"] as const) {
      const title = topic[lang];
      if (!title) continue;
      const lesson = (lang === "en" ? enByTitle : mlByTitle).get(title);
      if (!lesson) {
        entry.notes.push(`map names a ${lang.toUpperCase()} lesson that isn't in the export: "${title}"`);
        continue;
      }
      seen[lang].add(title);
      entry.source[lang] = lesson;
    }
    return entry;
  });

  const unconsumed: { lang: Lang; title: string }[] = [
    ...en.filter((l) => !seen.en.has(l.title)).map((l) => ({ lang: "en" as const, title: l.title })),
    ...ml.filter((l) => !seen.ml.has(l.title)).map((l) => ({ lang: "ml" as const, title: l.title })),
  ];

  return { paired, unconsumed };
}

// ---------------------------------------------------------------- durations

/**
 * The exported durationMins are unreliable — English module 1 reports one
 * minute per episode against recordings that run to 25 — so the real length is
 * read out of each file's container. ffprobe fetches only the header it needs,
 * not the whole video, but 60-odd HTTPS round trips still add up, so results
 * are cached between runs.
 */
async function probeDuration(url: string): Promise<number | null> {
  const proc = Bun.spawn(
    [
      "ffprobe", "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      "-i", url,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (proc.exitCode !== 0) return null;
  const seconds = Number.parseFloat(out.trim());
  return Number.isFinite(seconds) ? Math.round(seconds) : null;
}

async function resolveDurations(urls: string[]): Promise<Map<string, number>> {
  const cacheFile = Bun.file(CACHE_PATH);
  const cache: Record<string, number> = (await cacheFile.exists()) ? await cacheFile.json() : {};
  const resolved = new Map<string, number>(Object.entries(cache));

  const missing = urls.filter((url) => !resolved.has(url));
  if (SKIP_PROBE) {
    if (missing.length) console.log(`  (--skip-probe: ${missing.length} durations left unknown)\n`);
    return resolved;
  }
  if (!missing.length) return resolved;

  process.stdout.write(`  probing ${missing.length} videos with ffprobe`);
  let done = 0;
  const CONCURRENCY = 6;
  const queue = [...missing];

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let url = queue.shift(); url; url = queue.shift()) {
        const seconds = await probeDuration(url);
        if (seconds !== null) resolved.set(url, seconds);
        if (++done % 10 === 0) process.stdout.write(".");
      }
    }),
  );
  process.stdout.write(" done\n\n");

  await Bun.write(CACHE_PATH, JSON.stringify(Object.fromEntries(resolved), null, 2));
  return resolved;
}

// ------------------------------------------------------------------- report

function minutes(seconds: number | undefined): string {
  if (seconds === undefined) return "  —  ";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(3)}:${String(s).padStart(2, "0")}`;
}

/** Both languages present, and the same length to the second. */
function hasBoth(en: number | undefined, ml: number | undefined): boolean {
  return en !== undefined && ml !== undefined && en === ml;
}

function pad(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

// --------------------------------------------------------------------- main

async function main() {
  const enPath = arg("en");
  const mlPath = arg("ml");
  if (!enPath || !mlPath) {
    console.error("Usage: bun run scripts/import-content.ts --en <path> --ml <path> [--write] [--skip-probe]");
    process.exit(1);
  }

  const [enSource, mlSource] = await Promise.all([
    loadExport(enPath, "English"),
    loadExport(mlPath, "Malayalam"),
  ]);

  const enSections = sortedSections(enSource);
  const mlSections = sortedSections(mlSource);

  console.log(`\n  English   ${enSource.course.title}  (${enSections.reduce((n, s) => n + s.lessons.length, 0)} lessons)`);
  console.log(`  Malayalam ${mlSource.course.title}  (${mlSections.reduce((n, s) => n + s.lessons.length, 0)} lessons)\n`);

  // Set the known-duplicate Malayalam uploads aside before any pairing runs.
  const dropped: { title: string; reason: string }[] = [];
  const mlFiltered = mlSections.map((section) => ({
    ...section,
    lessons: section.lessons.filter((lesson) => {
      const reason = droppedTitles.get(lesson.title);
      if (reason) dropped.push({ title: lesson.title, reason });
      return !reason;
    }),
  }));

  const modules = MODULE_TITLES.map((title, i) => {
    const en = enSections[i]?.lessons ?? [];
    const ml = mlFiltered[i]?.lessons ?? [];
    const { paired, unconsumed } = i === 2 ? pairByTopic(en, ml) : pairByNumber(i, en, ml);
    return { order: i, title, paired, unconsumed };
  });

  const urls = [
    ...new Set(
      modules.flatMap((m) =>
        m.paired.flatMap((e) =>
          (["en", "ml"] as const).map((lang) => e.source[lang]?.contentUrl).filter((u): u is string => !!u),
        ),
      ),
    ),
  ];
  const durations = await resolveDurations(urls);

  // ------------------------------------------------------------ the report
  let pairs = 0;
  let enOnly = 0;
  let mlOnly = 0;
  let missingVideo = 0;
  const notes: string[] = [];

  for (const module of modules) {
    console.log(`\n  MODULE ${module.order + 1} — ${module.title.en}`);
    console.log(`  ${"".padEnd(96, "─")}`);
    console.log(`  ${pad("KEY", 20)}${pad("TITLE", 40)}${pad("EN", 9)}${pad("ML", 9)}PAIRING`);

    for (const episode of module.paired) {
      const enUrl = episode.source.en?.contentUrl;
      const mlUrl = episode.source.ml?.contentUrl;
      const enSec = enUrl ? durations.get(enUrl) : undefined;
      const mlSec = mlUrl ? durations.get(mlUrl) : undefined;

      // Identical runtimes on separate files means the same recording was
      // filed twice, once per language.
      if (hasBoth(enSec, mlSec) && !TRUST_IDENTICAL) {
        episode.suspectMl = true;
        notes.push(
          `M${module.order + 1} ${episode.key}: Malayalam runs ${minutes(mlSec)} — identical to the English. Withheld; listen before trusting it.`,
        );
      }

      const hasEn = !!enUrl;
      const hasMl = !!mlUrl && !episode.suspectMl;
      if (hasEn && hasMl) pairs++;
      else if (hasEn) enOnly++;
      else if (hasMl) mlOnly++;

      let state: string;
      if (hasEn && hasMl) state = "paired";
      else if (hasEn) state = "ENGLISH ONLY";
      else if (hasMl) state = "MALAYALAM ONLY";
      else state = "NO VIDEO";
      if (episode.suspectMl) state = "ENGLISH ONLY  ← ML withheld";

      // An episode present in the export but with no contentUrl is a content
      // gap, not a pairing gap — worth separating in the summary.
      for (const lang of ["en", "ml"] as const) {
        if (episode.source[lang] && !episode.source[lang]?.contentUrl) {
          missingVideo++;
          notes.push(
            `M${module.order + 1} ${episode.key}: ${lang.toUpperCase()} lesson "${episode.source[lang]?.title}" has no video URL`,
          );
        }
      }

      const free = FREE_EPISODES.has(`${module.order}/${episode.key}`) ? " ★free" : "";
      console.log(
        `  ${pad(episode.key, 20)}${pad(episode.title.en, 40)}${pad(minutes(enSec), 9)}${pad(minutes(mlSec), 9)}${state}${free}`,
      );
      for (const note of episode.notes) notes.push(`M${module.order + 1} ${episode.key}: ${note}`);
    }

    for (const item of module.unconsumed) {
      const hint = UNCLAIMED[item.title];
      console.log(`  ${pad("!! UNCLAIMED", 20)}${pad(item.title, 40)}${item.lang.toUpperCase()}`);
      notes.push(
        `M${module.order + 1}: unclaimed ${item.lang.toUpperCase()} file "${item.title}"` +
          (hint ? ` — ${hint}` : " — not named by any pairing rule"),
      );
    }
  }

  const total = modules.reduce((n, m) => n + m.paired.length, 0);
  console.log(`\n  ${"".padEnd(96, "═")}`);
  console.log(`  ${total} episodes across ${modules.length} modules`);
  console.log(`  ${pairs} in both languages · ${enOnly} English only · ${mlOnly} Malayalam only`);
  console.log(`  ${dropped.length} duplicate Malayalam uploads set aside · ${missingVideo} lessons with no video file`);

  if (dropped.length) {
    console.log(`\n  SET ASIDE`);
    for (const d of dropped) console.log(`    ${pad(d.title, 52)}${d.reason}`);
  }
  if (notes.length) {
    console.log(`\n  NEEDS ATTENTION`);
    for (const note of notes) console.log(`    · ${note}`);
  }

  if (!WRITE) {
    console.log(`\n  Dry run — nothing written. Re-run with --write to commit.\n`);
    return;
  }

  // -------------------------------------------------------------- the write
  const db = await getDb();
  const now = new Date();

  const courseResult = await db.collection<Course>(COURSES).findOneAndUpdate(
    { slug: COURSE_SLUG },
    {
      $set: {
        title: { en: "Master Software Development with AI" },
        blurb: { en: enSource.course.description?.replace(/\s+/g, " ").trim() ?? "" },
        updatedAt: now,
      },
      $setOnInsert: { slug: COURSE_SLUG, createdAt: now },
    },
    { upsert: true, returnDocument: "after" },
  );
  const courseId = courseResult?._id;
  if (!courseId) throw new Error("Failed to upsert the course document");

  let moduleCount = 0;
  let episodeCount = 0;
  /** Every (module, key) this run produced, so a re-run after the pairing rules
   *  change can clear out episodes that no longer exist rather than leaving
   *  orphans behind under their old keys. */
  const written: { moduleId: ObjectId; key: string }[] = [];

  for (const module of modules) {
    const moduleResult = await db.collection<Module>(MODULES).findOneAndUpdate(
      { courseId, order: module.order },
      {
        $set: { title: module.title, updatedAt: now },
        $setOnInsert: { courseId, order: module.order, blurb: { en: "" }, createdAt: now },
      },
      { upsert: true, returnDocument: "after" },
    );
    const moduleId = moduleResult?._id;
    if (!moduleId) throw new Error(`Failed to upsert module ${module.order}`);
    moduleCount++;

    for (const episode of module.paired) {
      const media: Partial<Record<Lang, Media>> = {};
      for (const lang of ["en", "ml"] as const) {
        if (lang === "ml" && episode.suspectMl) continue;
        const url = episode.source[lang]?.contentUrl;
        if (!url) continue;
        media[lang] = { url, durationSec: durations.get(url) ?? 0 };
      }
      // An episode with no playable file in either language would render as a
      // dead row in the contents list, so it isn't written at all.
      if (!media.en && !media.ml) continue;

      await db.collection<Episode>(EPISODES).updateOne(
        { moduleId, key: episode.key },
        {
          $set: {
            order: episode.order,
            title: episode.title,
            media,
            isFree: FREE_EPISODES.has(`${module.order}/${episode.key}`),
            updatedAt: now,
          },
          $setOnInsert: { courseId, moduleId, key: episode.key, blurb: { en: "" }, createdAt: now },
        },
        { upsert: true },
      );
      written.push({ moduleId, key: episode.key });
      episodeCount++;
    }
  }

  const keysByModule = new Map<string, string[]>();
  for (const { moduleId, key } of written) {
    const id = moduleId.toHexString();
    keysByModule.set(id, [...(keysByModule.get(id) ?? []), key]);
  }
  let pruned = 0;
  for (const [id, keys] of keysByModule) {
    const result = await db
      .collection<Episode>(EPISODES)
      .deleteMany({ moduleId: new ObjectId(id), key: { $nin: keys } });
    pruned += result.deletedCount;
  }

  console.log(
    `\n  Written into "${db.databaseName}": 1 course, ${moduleCount} modules, ${episodeCount} episodes` +
      (pruned ? `, ${pruned} stale episodes removed` : "") +
      ".\n",
  );
  await closeDb();
}

main().catch(async (err) => {
  console.error("\n  Import failed:", err instanceof Error ? err.message : err, "\n");
  await closeDb();
  process.exit(1);
});
