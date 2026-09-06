/**
 * Every judgement call the import makes, in one file.
 *
 * The two source courses were authored independently, so folding them into one
 * bilingual course means deciding which English lesson is the same episode as
 * which Malayalam one. Modules 1, 2 and 4 answer that themselves — both sides
 * number their lessons "ep-N". Module 3 doesn't number anything, so the pairing
 * there is a hand-written map below and should be read before it's trusted.
 *
 * Nothing here is inferred at runtime from titles or durations. Fuzzy matching
 * on a 74-lesson catalogue would be impossible to review; an explicit list can
 * be checked line by line and argued with.
 */

/** Module titles. The exports call all four "module 1".."module 4". */
export const MODULE_TITLES: { en: string; ml?: string }[] = [
  { en: "AI foundations" },
  { en: "Designing and shipping your first sites" },
  { en: "Full-stack projects" },
  { en: "Mobile apps" },
];

/**
 * Malayalam entries that hold no Malayalam content.
 *
 * Each was settled by comparing the loudness envelope of the two audio tracks:
 * two encodes of one take correlate at 1.000, while the same screencast
 * narrated in two languages sits below 0.2 (across all 26 confirmed pairs the
 * highest was 0.189). Nothing here is a guess from the filename.
 *
 * The five "ep-N" rows are the important ones — they look like Malayalam
 * lessons in the export, and they are the English video.
 */
export const DROPPED: { title: string; reason: string }[] = [
  // Redundant re-uploads: identical to the numbered episode they sit beside.
  { title: "ep1 , typical ai designs[Malayalam]", reason: "r=1.000 against ep-1 — same recording" },
  { title: "ep2 , Creating Designs using Figma Stitch [malayalam]", reason: "duplicate of ep-3 (same 7:10 runtime)" },
  { title: "github-malayalam_bgm-only", reason: "duplicate of ep-8 (same 7:06 runtime)" },
  { title: "custom-domain-malayalam_bgm-only", reason: "duplicate of ep-10 (same 12:44 runtime)" },
  { title: "design-references-malayalam_bgm-only", reason: "has no video file at all" },

  // The English recording, filed into the Malayalam course.
  { title: "ep-2 , design reference", reason: "r=1.000 against English ep-2 — it IS the English video" },
  { title: "ep-4 , claude code setup", reason: "r=1.000 against English ep-4 — it IS the English video" },
  { title: "ep-5 , skills and commands", reason: "r=1.000 against English ep-5 — it IS the English video" },
  { title: "ep-7 , Building a Portfolio Website", reason: "r=1.000 against English ep-7 — it IS the English video" },
  { title: "ep-9 , vercel portfolio hosting", reason: "r=1.000 against English ep-9 — it IS the English video" },

  // Filed under module 3, but it is module 2's opening episode.
  { title: "ai-designs-malayalam_bgm-only", reason: "r=1.000 against module 2 ep-1 — misfiled duplicate" },
];

/** Hints for files no rule claims, so the report can name what one might be
 *  rather than printing a bare filename. Empty now that both former entries
 *  were identified and promoted in ALIASES below. */
export const UNCLAIMED: Record<string, string> = {};

/**
 * Malayalam lessons that belong to a numbered episode but weren't filed under
 * one. Only one so far: module 2's landing-page recording is the Malayalam
 * ep-6, and without this line ep-6 would look English-only.
 */
export const ALIASES: { title: string; moduleOrder: number; key: string }[] = [
  { title: "landing-page-malayalam_bgm-only", moduleOrder: 1, key: "ep-6" },
  // The real Malayalam recordings for two episodes whose own "ep-N" row turned
  // out to hold the English video. Both were checked for narration rather than
  // trusted on the "_bgm-only" name: each pauses for about a quarter of its
  // runtime, matching the confirmed narrated files.
  { title: "claude-ai[malayalam] (1)", moduleOrder: 1, key: "ep-4" },
  { title: "portfolio-malayalam_bgm-only", moduleOrder: 1, key: "ep-7" },
];

/**
 * Module 3, paired by topic because neither side numbers its lessons.
 *
 * `en` and `ml` are exact source titles; `null` means that language has no
 * recording of this episode. Order is the teaching sequence — build the
 * ecommerce app, then the Instagram clone — not the order either export
 * happened to be in.
 */
export const MODULE_3: { key: string; title: string; en: string | null; ml: string | null }[] = [
  {
    key: "ecommerce-planning",
    title: "Planning the ecommerce project",
    en: "ecommerce-planning",
    ml: "ecommerce-planning [malayalam]",
  },
  {
    key: "ecommerce-build-1",
    title: "Building the ecommerce app, part 1",
    en: "ecommerse project-building (1) [English]",
    ml: "ecommerse project-building (1) [Malayalam]",
  },
  {
    key: "ecommerce-build-2",
    title: "Building the ecommerce app, part 2",
    en: "ecommerce project building 2",
    ml: "project-building-2-malayalam_bgm-only",
  },
  {
    key: "ecommerce-build-3",
    title: "Building the ecommerce app, part 3",
    en: "ecommerse project-building (3)",
    ml: "project-building-3-malayalam_bgm-only",
  },
  {
    key: "ecommerce-md-files",
    title: "Ecommerce project MD files",
    en: "ecommerse project-MD files(1) [English]",
    ml: "ecommerce-md-files-malayalam_bgm-only",
  },
  {
    key: "ecommerce-hosting",
    title: "Hosting the ecommerce app",
    en: "ecommerce-hosting",
    ml: "ecommerce-hosting-malayalam_bgm-only",
  },
  {
    key: "fullstack",
    title: "Full stack, explained",
    en: "fullstack[english]",
    ml: "full-stack-explained-malayalam_bgm-only",
  },
  {
    key: "tech-stacks",
    title: "Choosing a tech stack",
    en: "tech-stacks[english]",
    ml: "tech-stacks-malayalam_bgm-only",
  },
  {
    key: "instagram-planning",
    title: "Planning the Instagram clone",
    en: null,
    ml: "instagram-clone-planning-malayalam_bgm-only",
  },
  {
    key: "instagram-build-1",
    title: "Building the Instagram clone",
    en: "indiagram-stage2_bgm-only",
    ml: "instagram-clone-1-malayalam_bgm-only",
  },
  {
    key: "instagram-final",
    title: "Finishing the Instagram clone",
    en: "instagram-clone finel",
    ml: "instagram-clone-building-finel-malayalam_bgm-only",
  },
  {
    key: "instagram-hosting",
    title: "Hosting the Instagram clone",
    en: "instagram-hosting_bgm-only",
    ml: null,
  },
];

/** Episodes given away free. Matches what the marketing site already streams
 *  on /watch, so the two can't drift apart. */
export const FREE_EPISODES = new Set(["0/ep-1"]);

/**
 * Reads the episode number out of a source title. Handles every spelling the
 * two exports use: "ep-1", "ep2", "ep - 1", "ep-10 , Custom Domain".
 */
export function episodeNumber(title: string): number | null {
  const match = /^\s*ep\s*-?\s*(\d+)\b/i.exec(title);
  return match?.[1] ? Number(match[1]) : null;
}

/**
 * Turns a source title into something worth showing a learner: drops the "ep-4 ,"
 * prefix, the "_bgm-only" working suffix, and the "[english]" / "[malayalam]"
 * tags that only ever meant "this is the other language's file".
 */
export function cleanTitle(title: string): string {
  return title
    .replace(/^\s*ep\s*-?\s*\d+\s*,?\s*/i, "")
    .replace(/_bgm-only/gi, "")
    .replace(/\[(english|malayalam)\]/gi, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/[\s-]+/g, " ")
    .trim();
}

/**
 * True when a cleaned title is really a filename — all lowercase, no spaces
 * left once the hyphens are gone. Those read as build artefacts in a course
 * contents list, so the Malayalam side borrows the English title instead and
 * the import reports every time it did.
 */
export function looksLikeFilename(cleaned: string): boolean {
  return cleaned.length > 0 && cleaned === cleaned.toLowerCase() && !/[A-Z]/.test(cleaned);
}
