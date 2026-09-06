import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { getDb } from "../db.ts";
import { env } from "../env.ts";
import { COURSES, type Course } from "../content/types.ts";
import { grantAccess } from "../auth/access.ts";
import { createHandoff } from "../auth/handoff.ts";
import { upsertUserByEmail } from "../auth/users.ts";
import { looksLikeEmail, normalizeEmail } from "../auth/crypto.ts";
import type { Entitlement } from "../auth/types.ts";

/** The course a purchase on the marketing site buys. One programme today; the
 *  caller can name a different slug if that changes. */
const DEFAULT_COURSE_SLUG = "ai-academy";

const SOURCES: Entitlement["source"][] = ["razorpay", "abzer", "coupon", "manual"];

export const internalRoutes = new Hono();

/**
 * Server-to-server only. The marketing site holds the secret; no browser ever
 * sees it, and CORS is irrelevant because nothing calls this from a page.
 */
internalRoutes.use("*", async (c, next) => {
  const presented = c.req.header("X-Internal-Secret") ?? "";
  const expected = env.internalSecret();
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.json({ error: "Not authorised" }, 401);
  }
  await next();
});

/**
 * Turns a completed payment into an account and access to the course.
 *
 * Idempotent on `orderRef`: a webhook retry, or the browser callback racing the
 * webhook, grants once. The handoff token is returned every time regardless —
 * a repeat call usually means the buyer is sitting on the thank-you page right
 * now, and they still need signing in.
 */
internalRoutes.post("/grant", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail(String(body?.email ?? ""));
  const orderRef = String(body?.orderRef ?? "").trim();
  const source = String(body?.source ?? "");

  if (!looksLikeEmail(email)) return c.json({ error: "A valid email is required" }, 400);
  if (!orderRef) return c.json({ error: "orderRef is required" }, 400);
  if (!SOURCES.includes(source as Entitlement["source"])) {
    return c.json({ error: `source must be one of ${SOURCES.join(", ")}` }, 400);
  }

  const db = await getDb();
  const slug = String(body?.courseSlug ?? DEFAULT_COURSE_SLUG);
  const course = await db.collection<Course>(COURSES).findOne({ slug });
  if (!course?._id) return c.json({ error: `No course with slug "${slug}"` }, 404);

  const user = await upsertUserByEmail(email, {
    name: typeof body?.name === "string" ? body.name.trim() : undefined,
    phone: typeof body?.phone === "string" ? body.phone.trim() : undefined,
    country: typeof body?.country === "string" ? body.country.trim() : undefined,
  });

  const { created } = await grantAccess({
    userId: user._id!,
    courseId: course._id,
    source: source as Entitlement["source"],
    orderRef,
  });

  return c.json({
    userId: user._id!.toHexString(),
    email: user.email,
    granted: created,
    alreadyGranted: !created,
    handoffToken: await createHandoff(user._id!),
  });
});
