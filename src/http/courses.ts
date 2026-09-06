import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { getDb } from "../db.ts";
import { COURSES, EPISODES, MODULES, PROGRESS, type Course, type Episode, type Module, type Progress } from "../content/types.ts";
import { hasEntitlement } from "../auth/access.ts";
import { optionalAuth, type Vars } from "../auth/middleware.ts";
import { playbackUrl } from "../media/r2.ts";
import { env } from "../env.ts";

export const courseRoutes = new Hono<{ Variables: Partial<Vars> }>();

/** Swaps each stored URL for a signed, expiring one. Both languages at once,
 *  so switching language mid-episode needs no second round trip. */
async function signedSources(media: Episode["media"]) {
  const entries = await Promise.all(
    Object.entries(media).map(async ([lang, value]) => [
      lang,
      { url: await playbackUrl(value.url), durationSec: value.durationSec },
    ]),
  );
  return Object.fromEntries(entries);
}

/**
 * The contents of a course, without any playback URLs.
 *
 * Deliberately readable by anyone: the course view shows the full module and
 * episode list to a visitor who hasn't paid, with the locked state made
 * obvious, which is far more persuasive than an empty page. The videos
 * themselves come from /episodes/:id/play, which does check.
 */
courseRoutes.get("/courses/:slug", optionalAuth, async (c) => {
  const db = await getDb();
  const course = await db.collection<Course>(COURSES).findOne({ slug: c.req.param("slug") ?? "" });
  if (!course?._id) return c.json({ error: "No such course" }, 404);

  const [modules, episodes] = await Promise.all([
    db.collection<Module>(MODULES).find({ courseId: course._id }).sort({ order: 1 }).toArray(),
    db.collection<Episode>(EPISODES).find({ courseId: course._id }).sort({ order: 1 }).toArray(),
  ]);

  const user = c.get("user");
  const entitled = user?._id ? await hasEntitlement(user._id, course._id) : false;

  // Fetched with the course rather than as its own request: the contents list
  // renders every episode's progress at once, so a second round trip would
  // only ever be made immediately after this one.
  const progressRows = user?._id
    ? await db.collection<Progress>(PROGRESS).find({ userId: user._id, courseId: course._id }).toArray()
    : [];
  const progressByEpisode = new Map(progressRows.map((row) => [row.episodeId.toHexString(), row]));

  // Where "continue watching" points: the most recently touched episode that
  // isn't finished. Someone who has completed everything gets no resume card
  // rather than being sent back to the last thing they finished.
  const resumeRow = progressRows
    .filter((row) => !row.completedAt)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];

  const byModule = new Map<string, Episode[]>();
  for (const episode of episodes) {
    const id = episode.moduleId.toHexString();
    byModule.set(id, [...(byModule.get(id) ?? []), episode]);
  }

  return c.json({
    course: { slug: course.slug, title: course.title, blurb: course.blurb },
    entitled,
    resumeEpisodeId: resumeRow?.episodeId.toHexString() ?? null,
    modules: modules.map((module) => ({
      id: module._id!.toHexString(),
      order: module.order,
      title: module.title,
      blurb: module.blurb,
      episodes: (byModule.get(module._id!.toHexString()) ?? []).map((episode) => ({
        id: episode._id!.toHexString(),
        key: episode.key,
        order: episode.order,
        title: episode.title,
        blurb: episode.blurb,
        isFree: episode.isFree,
        progress: (() => {
          const row = progressByEpisode.get(episode._id!.toHexString());
          if (!row) return null;
          return {
            positionSec: row.positionSec,
            completed: Boolean(row.completedAt),
            lastLang: row.lastLang,
          };
        })(),
        // Which languages exist, and how long each runs — enough to render the
        // contents list and the language toggle without exposing the files.
        languages: Object.fromEntries(
          Object.entries(episode.media).map(([lang, media]) => [lang, { durationSec: media.durationSec }]),
        ),
      })),
    })),
  });
});

/**
 * Playback URLs for one episode, both languages at once so switching language
 * mid-episode doesn't need another round trip.
 *
 * Note what this does and doesn't protect: the files currently sit on a public
 * bucket, so a URL handed out here works for anyone who gets hold of it, with
 * or without an account. Closing that is phase 5 — signed, expiring URLs — and
 * this route is where that swap happens, so callers won't change.
 */
courseRoutes.get("/episodes/:id/play", optionalAuth, async (c) => {
  const id = c.req.param("id") ?? "";
  if (!ObjectId.isValid(id)) return c.json({ error: "No such episode" }, 404);

  const db = await getDb();
  const episode = await db.collection<Episode>(EPISODES).findOne({ _id: new ObjectId(id) });
  if (!episode) return c.json({ error: "No such episode" }, 404);

  if (!episode.isFree) {
    const user = c.get("user");
    if (!user?._id) return c.json({ error: "Sign in to watch this episode" }, 401);
    if (!(await hasEntitlement(user._id, episode.courseId))) {
      return c.json({ error: "Join the programme to watch this episode" }, 403);
    }
  }

  return c.json({
    episodeId: episode._id!.toHexString(),
    title: episode.title,
    isFree: episode.isFree,
    sources: await signedSources(episode.media),
    expiresIn: env.videoUrlTtl(),
  });
});

/**
 * The one episode given away free, resolved without an account.
 *
 * The marketing site's /watch page and its popup player both need this, and
 * they have no session and no episode id to work from. A dedicated route means
 * one request instead of fetching the whole course to find which episode is
 * free — and it means the free episode keeps working once the bucket is
 * private, which hardcoded public URLs would not.
 */
courseRoutes.get("/episodes/free", async (c) => {
  const db = await getDb();
  const course = await db.collection<Course>(COURSES).findOne({ slug: "ai-academy" });
  if (!course?._id) return c.json({ error: "No such course" }, 404);

  const episode = await db
    .collection<Episode>(EPISODES)
    .findOne({ courseId: course._id, isFree: true }, { sort: { order: 1 } });
  if (!episode) return c.json({ error: "No free episode" }, 404);

  return c.json({
    episodeId: episode._id!.toHexString(),
    title: episode.title,
    sources: await signedSources(episode.media),
    expiresIn: env.videoUrlTtl(),
  });
});
