import { Hono } from "hono";
import { getDb } from "../db.ts";
import { COURSES, type Course, type Lang } from "../content/types.ts";
import { listEntitlements } from "../auth/access.ts";
import { requireAuth, type Vars } from "../auth/middleware.ts";
import { USERS, type User } from "../auth/types.ts";

export const meRoutes = new Hono<{ Variables: Vars }>();

/** Who is signed in, and what they can open. */
meRoutes.get("/me", requireAuth, async (c) => {
  const user = c.get("user");
  const entitlements = await listEntitlements(user._id!);

  const db = await getDb();
  const courses = entitlements.length
    ? await db
        .collection<Course>(COURSES)
        .find({ _id: { $in: entitlements.map((e) => e.courseId) } })
        .toArray()
    : [];

  return c.json({
    user: {
      id: user._id!.toHexString(),
      email: user.email,
      name: user.name,
      preferredLang: user.preferredLang,
    },
    courses: courses.map((course) => ({ slug: course.slug, title: course.title })),
  });
});

/** The language the course view opens in, kept on the account so the choice
 *  follows the learner between devices. */
meRoutes.patch("/me", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const lang = body?.preferredLang;
  if (lang !== "en" && lang !== "ml") {
    return c.json({ error: "preferredLang must be \"en\" or \"ml\"" }, 400);
  }

  const user = c.get("user");
  const db = await getDb();
  await db
    .collection<User>(USERS)
    .updateOne({ _id: user._id }, { $set: { preferredLang: lang as Lang } });
  return c.json({ ok: true, preferredLang: lang });
});
