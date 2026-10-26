import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { getDb } from "../db.ts";
import { playbackUrl } from "../media/r2.ts";
import {
  COURSES,
  MODULES,
  EPISODES,
  LANGS,
  type Episode,
  type Lang,
  type Module,
} from "../content/types.ts";

/**
 * Editing the course from the admin panel: rename, reorder, repoint a video.
 *
 * Mounted under /internal, so it inherits that router's shared-secret guard —
 * the marketing site's admin routes hold the secret and call this server to
 * server. No browser ever sees it.
 *
 * Content lived in scripts until now. Scripts are right for the import, which
 * rebuilds the whole course from exports; they are wrong for "the two intro
 * lessons are at the end of module 3", which is a thirty-second fix that
 * should not need a terminal and a database URI.
 *
 * Deliberately narrow: titles, order, and the URL a language's video points
 * at. Creating and deleting episodes stays with the import, which can do it
 * consistently across both languages and knows how to prune what the LMS no
 * longer has.
 */

export const contentAdminRoutes = new Hono();

const COURSE_SLUG = "ai-academy";

/** A title or blurb as it arrives from the client. `ml` may be absent — plenty
 *  of episodes have no Malayalam recording and no Malayalam title either. */
type LocalizedInput = { en?: unknown; ml?: unknown };

function cleanLocalized(
  input: LocalizedInput | undefined,
  current: { en: string; ml?: string },
): { en: string; ml?: string } | null {
  if (!input || typeof input !== "object") return null;
  const en = typeof input.en === "string" ? input.en.trim() : current.en;
  if (en.length === 0) return null;
  const mlRaw = typeof input.ml === "string" ? input.ml.trim() : current.ml;
  // An empty Malayalam title is stored as absent rather than "", so the course
  // view's "no Malayalam yet" check keeps working.
  return mlRaw ? { en, ml: mlRaw } : { en };
}

function objectId(value: string): ObjectId | null {
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
}

/**
 * The whole course as the editor needs it — every module, every episode, both
 * languages, in order. One request rather than a tree of them: the admin shows
 * it all at once, and four modules of a dozen episodes is a small document.
 */
contentAdminRoutes.get("/content/course", async (c) => {
  const db = await getDb();
  const course = await db.collection<{ _id: ObjectId; slug: string }>(COURSES).findOne({
    slug: COURSE_SLUG,
  });
  if (!course) return c.json({ error: "Course not found" }, 404);

  const [modules, episodes] = await Promise.all([
    db.collection<Module>(MODULES).find({ courseId: course._id }).sort({ order: 1 }).toArray(),
    db.collection<Episode>(EPISODES).find({ courseId: course._id }).sort({ order: 1 }).toArray(),
  ]);

  const byModule = new Map<string, Episode[]>();
  for (const episode of episodes) {
    const key = episode.moduleId.toHexString();
    byModule.set(key, [...(byModule.get(key) ?? []), episode]);
  }

  return c.json({
    courseId: course._id.toHexString(),
    modules: modules.map((module) => ({
      id: module._id!.toHexString(),
      order: module.order,
      title: module.title,
      episodes: (byModule.get(module._id!.toHexString()) ?? []).map((episode) => ({
        id: episode._id!.toHexString(),
        key: episode.key,
        order: episode.order,
        title: episode.title,
        isFree: Boolean(episode.isFree),
        media: Object.fromEntries(
          LANGS.filter((lang) => episode.media?.[lang]).map((lang) => [
            lang,
            {
              url: episode.media[lang]!.url,
              durationSec: episode.media[lang]!.durationSec,
              streamUid: episode.media[lang]!.streamUid ?? null,
            },
          ]),
        ),
      })),
    })),
  });
});

/** Rename a module. */
contentAdminRoutes.patch("/content/modules/:id", async (c) => {
  const id = objectId(c.req.param("id"));
  if (!id) return c.json({ error: "Bad id" }, 400);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid body" }, 400);

  const db = await getDb();
  const module = await db.collection<Module>(MODULES).findOne({ _id: id });
  if (!module) return c.json({ error: "Module not found" }, 404);

  const title = cleanLocalized(body.title, module.title);
  if (!title) return c.json({ error: "An English title is required." }, 400);

  await db
    .collection<Module>(MODULES)
    .updateOne({ _id: id }, { $set: { title, updatedAt: new Date() } });
  return c.json({ ok: true, title });
});

/**
 * Rename an episode, or repoint one language's video.
 *
 * The duration is kept as it was unless the URL changes, in which case it is
 * zeroed: it described the old file and a wrong duration is worse than none.
 * The real figure is probed from the file by the import and the LMS sync —
 * this endpoint has no business downloading a video inside a request.
 *
 * Clearing a URL removes that language entirely, which is how an episode goes
 * back to "no Malayalam recording yet" rather than holding a dead link.
 */
contentAdminRoutes.patch("/content/episodes/:id", async (c) => {
  const id = objectId(c.req.param("id"));
  if (!id) return c.json({ error: "Bad id" }, 400);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid body" }, 400);

  const db = await getDb();
  const episode = await db.collection<Episode>(EPISODES).findOne({ _id: id });
  if (!episode) return c.json({ error: "Episode not found" }, 404);

  const set: Record<string, unknown> = { updatedAt: new Date() };
  const unset: Record<string, ""> = {};

  if (body.title !== undefined) {
    const title = cleanLocalized(body.title, episode.title);
    if (!title) return c.json({ error: "An English title is required." }, 400);
    set.title = title;
  }

  if (body.media !== undefined) {
    if (typeof body.media !== "object" || body.media === null) {
      return c.json({ error: "Invalid media." }, 400);
    }
    for (const lang of LANGS as Lang[]) {
      const incoming = (body.media as Record<string, unknown>)[lang];
      if (incoming === undefined) continue;

      if (incoming === null || incoming === "") {
        unset[`media.${lang}`] = "";
        continue;
      }
      const url = typeof incoming === "string" ? incoming.trim() : "";
      if (!url) return c.json({ error: `Invalid ${lang} video.` }, 400);

      const existing = episode.media?.[lang];
      if (existing && existing.url === url) continue; // nothing changed

      set[`media.${lang}`] = {
        url,
        // Unknown until something probes the file. See the note above.
        durationSec: 0,
        // A new file is not the old Stream upload, so the uid cannot carry
        // over — leaving it would play the previous video.
        ...(existing?.streamUid && existing.url === url
          ? { streamUid: existing.streamUid }
          : {}),
      };
    }
  }

  const update: Record<string, unknown> = { $set: set };
  if (Object.keys(unset).length > 0) update.$unset = unset;

  await db.collection<Episode>(EPISODES).updateOne({ _id: id }, update);
  const after = await db.collection<Episode>(EPISODES).findOne({ _id: id });
  return c.json({ ok: true, episode: { id, title: after?.title, media: after?.media } });
});

/**
 * Reorder, by sending the whole list rather than a move.
 *
 * The client posts the ids in their new order and they are written as 0..n-1.
 * A "move item 7 to position 2" API has to be applied to the exact state it
 * was computed against; this cannot drift, and two admins saving at once end
 * with one of the two orders rather than an interleaving of both.
 */
async function applyOrder(
  collection: typeof MODULES | typeof EPISODES,
  ids: unknown,
  scope: Record<string, unknown>,
): Promise<{ error: string } | { count: number }> {
  if (!Array.isArray(ids) || ids.length === 0) return { error: "No order given." };

  const parsed: ObjectId[] = [];
  for (const raw of ids) {
    const id = typeof raw === "string" ? objectId(raw) : null;
    if (!id) return { error: "Bad id in order." };
    parsed.push(id);
  }
  if (new Set(parsed.map((id) => id.toHexString())).size !== parsed.length) {
    return { error: "Duplicate id in order." };
  }

  const db = await getDb();
  // Every row in scope has to be accounted for, or a save from a stale page
  // would drop whatever it had not seen to position 0 alongside something
  // else.
  const existing = await db.collection(collection).find(scope).project({ _id: 1 }).toArray();
  const have = new Set(existing.map((row) => row._id.toHexString()));
  if (have.size !== parsed.length || parsed.some((id) => !have.has(id.toHexString()))) {
    return { error: "The list has changed since this page loaded — reload and try again." };
  }

  const now = new Date();
  const result = await db.collection(collection).bulkWrite(
    parsed.map((id, index) => ({
      updateOne: { filter: { _id: id }, update: { $set: { order: index, updatedAt: now } } },
    })),
  );
  return { count: result.modifiedCount };
}

/** Reorder the episodes within one module. */
contentAdminRoutes.post("/content/modules/:id/reorder", async (c) => {
  const moduleId = objectId(c.req.param("id"));
  if (!moduleId) return c.json({ error: "Bad id" }, 400);

  const body = await c.req.json().catch(() => null);
  const outcome = await applyOrder(EPISODES, body?.episodeIds, { moduleId });
  if ("error" in outcome) return c.json(outcome, 400);
  return c.json({ ok: true, updated: outcome.count });
});

/** Reorder the modules themselves. */
contentAdminRoutes.post("/content/modules/reorder", async (c) => {
  const db = await getDb();
  const course = await db.collection<{ _id: ObjectId; slug: string }>(COURSES).findOne({
    slug: COURSE_SLUG,
  });
  if (!course) return c.json({ error: "Course not found" }, 404);

  const body = await c.req.json().catch(() => null);
  const outcome = await applyOrder(MODULES, body?.moduleIds, { courseId: course._id });
  if ("error" in outcome) return c.json(outcome, 400);
  return c.json({ ok: true, updated: outcome.count });
});

/**
 * A short-lived signed URL so the admin can watch a video before saving it.
 *
 * The stored `url` is the archive location in a private bucket — fetching it
 * directly answers 401 with an HTML error page, which a <video> element
 * reports as "format error" rather than anything that points at the cause.
 * Students never hit this because /episodes/:id/play signs first; the admin
 * needs the same treatment.
 *
 * Takes a URL rather than an episode id on purpose. The point of previewing
 * is to check a link that has been pasted in and not yet committed, and an
 * id can only ever resolve to what is already saved.
 */
contentAdminRoutes.post("/content/preview", async (c) => {
  const body = await c.req.json().catch(() => null);
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!url) return c.json({ error: "No URL given." }, 400);

  // Only ever signs; it cannot be pointed at something outside the bucket,
  // because keyFromUrl returns nothing for a URL that isn't ours and
  // playbackUrl then hands back the original unchanged.
  const signed = await playbackUrl(url);
  return c.json({ url: signed, signed: signed !== url });
});
