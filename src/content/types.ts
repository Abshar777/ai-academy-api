import type { ObjectId } from "mongodb";

/**
 * The two languages the programme is taught in. Every piece of learner-facing
 * text and every video exists per language, so this is the key type the whole
 * content model is built around.
 */
export type Lang = "en" | "ml";

export const LANGS: Lang[] = ["en", "ml"];

/**
 * Text that exists in both languages. `ml` is optional throughout: several
 * episodes have an English recording and no Malayalam one yet, and the course
 * view is expected to say so rather than pretend the episode doesn't exist.
 */
export type Localized = {
  en: string;
  ml?: string;
};

export type Media = {
  url: string;
  /** Probed from the file itself — the exported durationMins were wrong often
   *  enough (a 25-minute episode filed as 1 minute) to be worth ignoring. */
  durationSec: number;
};

export type Course = {
  _id?: ObjectId;
  slug: string;
  title: Localized;
  blurb: Localized;
  createdAt: Date;
  updatedAt: Date;
};

export type Module = {
  _id?: ObjectId;
  courseId: ObjectId;
  /** Zero-based position within the course. */
  order: number;
  title: Localized;
  blurb: Localized;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * One episode, both languages in a single document. This is the whole point of
 * the model: switching language is picking a different entry out of `media`,
 * not navigating to a different lesson — so the player keeps its position and
 * progress is recorded once per episode rather than once per language.
 */
export type Episode = {
  _id?: ObjectId;
  courseId: ObjectId;
  moduleId: ObjectId;
  /**
   * Stable identifier within the module — "ep-3" where the source numbered its
   * lessons, or a topic slug ("ecommerce-hosting") where it didn't. Used as the
   * upsert key, so re-running the import updates rather than duplicates.
   */
  key: string;
  order: number;
  title: Localized;
  /** Empty until someone writes them; the course view renders nothing rather
   *  than filler when a blurb is missing. */
  blurb: Localized;
  media: Partial<Record<Lang, Media>>;
  /** Episode 1 is the one the marketing site already gives away. */
  isFree: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Where someone got to in an episode — recorded per episode, not per language,
 * which is the payoff of the paired model: switch from English to Malayalam
 * and you keep your place, because it is the same episode either way.
 */
export type Progress = {
  _id?: ObjectId;
  userId: ObjectId;
  courseId: ObjectId;
  episodeId: ObjectId;
  positionSec: number;
  completedAt?: Date | null;
  /** Which language they were last watching in, so resuming picks it back up. */
  lastLang: Lang;
  updatedAt: Date;
};

export const COURSES = "courses";
export const MODULES = "modules";
export const EPISODES = "episodes";
export const PROGRESS = "progress";
