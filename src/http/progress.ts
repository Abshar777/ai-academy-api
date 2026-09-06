import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { getDb } from "../db.ts";
import { EPISODES, PROGRESS, type Episode, type Lang, type Progress } from "../content/types.ts";
import { hasEntitlement } from "../auth/access.ts";
import { requireAuth, type Vars } from "../auth/middleware.ts";

export const progressRoutes = new Hono<{ Variables: Vars }>();

/**
 * Records where someone got to.
 *
 * Called every few seconds while a video plays, so it is deliberately a single
 * upsert with no read first. `completedAt` uses `$min`-like semantics by only
 * being set once: re-watching an episode moves the position back but does not
 * un-complete it.
 */
progressRoutes.put("/progress/:episodeId", requireAuth, async (c) => {
  const episodeId = c.req.param("episodeId") ?? "";
  if (!ObjectId.isValid(episodeId)) return c.json({ error: "No such episode" }, 404);

  const body = await c.req.json().catch(() => null);
  const positionSec = Number(body?.positionSec);
  const lang = body?.lang;
  if (!Number.isFinite(positionSec) || positionSec < 0) {
    return c.json({ error: "positionSec must be a number of seconds" }, 400);
  }
  if (lang !== "en" && lang !== "ml") return c.json({ error: 'lang must be "en" or "ml"' }, 400);

  const db = await getDb();
  const episode = await db.collection<Episode>(EPISODES).findOne({ _id: new ObjectId(episodeId) });
  if (!episode) return c.json({ error: "No such episode" }, 404);

  const user = c.get("user");
  // Progress on an episode someone can't watch would be meaningless, and it
  // would let anyone write rows into the collection.
  if (!episode.isFree && !(await hasEntitlement(user._id!, episode.courseId))) {
    return c.json({ error: "Join the programme to watch this episode" }, 403);
  }

  const completed = body?.completed === true;
  await db.collection<Progress>(PROGRESS).updateOne(
    { userId: user._id!, episodeId: episode._id! },
    {
      $set: {
        positionSec: Math.round(positionSec),
        lastLang: lang as Lang,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        userId: user._id!,
        courseId: episode.courseId,
        episodeId: episode._id!,
      },
      // Set the first time it completes and left alone after, so a re-watch
      // doesn't reset the tick.
      ...(completed ? { $max: { completedAt: new Date() } } : {}),
    },
    { upsert: true },
  );

  return c.json({ ok: true });
});
