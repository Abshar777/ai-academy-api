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

/** Best-effort mirror of a purchase to the LMS. Never throws — logs and moves
 *  on, so the outcome of the grant never depends on the LMS being reachable. */
async function mirrorToLms(payload: {
  email: string; name?: string; phone?: string; orderId: string; amount?: number; currency?: string;
}): Promise<void> {
  const url = env.lmsPurchaseUrl();
  const secret = env.lmsSecret();
  if (!url || !secret) return; // integration not configured
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIA-Secret": secret },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error("[lms-mirror] non-2xx:", res.status, await res.text().catch(() => ""));
    else console.log("[lms-mirror] provisioned in LMS:", payload.email, payload.orderId);
  } catch (err) {
    console.error("[lms-mirror] failed:", err instanceof Error ? err.message : err);
  }
}

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

  const name = typeof body?.name === "string" ? body.name.trim() : undefined;
  const phone = typeof body?.phone === "string" ? body.phone.trim() : "";

  if (!looksLikeEmail(email)) return c.json({ error: "A valid email is required" }, 400);
  if (!orderRef) return c.json({ error: "orderRef is required" }, 400);
  if (!SOURCES.includes(source as Entitlement["source"])) {
    return c.json({ error: `source must be one of ${SOURCES.join(", ")}` }, 400);
  }

  /* Buyers must carry a phone number: it's rendered as a forensic video
     watermark downstream (v2 player + LMS), so a purchase can't provision
     an account without one. "manual" is an admin grant, not a buyer — exempt. */
  const BUYER_SOURCES: Entitlement["source"][] = ["razorpay", "abzer", "coupon"];
  if (BUYER_SOURCES.includes(source as Entitlement["source"]) && phone.replace(/\D/g, "").length < 7) {
    return c.json({ error: "A valid phone number is required" }, 400);
  }

  const db = await getDb();
  const slug = String(body?.courseSlug ?? DEFAULT_COURSE_SLUG);
  const course = await db.collection<Course>(COURSES).findOne({ slug });
  if (!course?._id) return c.json({ error: `No course with slug "${slug}"` }, 404);

  const user = await upsertUserByEmail(email, {
    name,
    phone: phone || undefined,
    country: typeof body?.country === "string" ? body.country.trim() : undefined,
  });

  const { created } = await grantAccess({
    userId: user._id!,
    courseId: course._id,
    source: source as Entitlement["source"],
    orderRef,
  });

  /* Mirror the purchase into the LMS (separate system): create/approve the
     student there and grant both-language access + a login-link email. Fire-
     and-forget — a slow or down LMS must never fail the purchase grant. */
  void mirrorToLms({
    email: user.email,
    name: name ?? user.name,
    phone: phone || user.phone,
    orderId: orderRef,
    amount: typeof body?.amount === "number" ? body.amount : undefined,
    currency: typeof body?.currency === "string" ? body.currency : undefined,
  });

  return c.json({
    userId: user._id!.toHexString(),
    email: user.email,
    granted: created,
    alreadyGranted: !created,
    handoffToken: await createHandoff(user._id!),
  });
});
