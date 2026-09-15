import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { getDb } from "../db.ts";
import { env } from "../env.ts";
import { COURSES, type Course } from "../content/types.ts";
import { grantAccess } from "../auth/access.ts";
import { createHandoff } from "../auth/handoff.ts";
import { upsertUserByEmail } from "../auth/users.ts";
import { looksLikeEmail, normalizeEmail } from "../auth/crypto.ts";
import type { Entitlement } from "../auth/types.ts";
import { isR2Configured, putObject } from "../media/r2.ts";

/** The course a purchase on the marketing site buys. One programme today; the
 *  caller can name a different slug if that changes. */
const DEFAULT_COURSE_SLUG = "ai-academy";

const SOURCES: Entitlement["source"][] = ["razorpay", "stripe", "abzer", "coupon", "manual"];

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

/* Image uploads for the blog editor.

   Here rather than in the marketing site because this service already holds the
   R2 credentials: the site would otherwise need its own copy of them, and a
   secret kept in two places is a secret rotated in one. The site forwards the
   file over the same shared-secret channel it already uses for /grant.

   The site checks type and size too. Checked again here because this is its own
   trust boundary: /internal is reachable by anything holding the secret, not
   only by the upload form. */

const MAX_BYTES = 5 * 1024 * 1024;

/* Allowlisted so the stored extension is ours rather than the uploader's — a
   filename is attacker-controlled and the served path must never inherit one.
   SVG is left out on purpose: it is a document that can carry script, and these
   are served from a hostname we would rather not have executing it. */
const TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

/* This service's own public origin, for building URLs it will itself serve.
   Taken from the request rather than another environment variable, since the
   caller reached us on exactly the hostname a reader's browser needs. The proxy
   headers are what nginx sets; PUBLIC_BASE_URL overrides the lot if the
   deployment ever makes that guess wrong. */
function selfOrigin(c: { req: { url: string; header: (name: string) => string | undefined } }): string {
  const configured = process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  const host = c.req.header("X-Forwarded-Host") ?? c.req.header("Host");
  // Falls back to the scheme the request actually arrived on rather than
  // assuming https, so a local http run does not hand back an https URL.
  const proto = c.req.header("X-Forwarded-Proto") ?? new URL(c.req.url).protocol.replace(":", "");
  if (host) return `${proto}://${host}`;
  return new URL(c.req.url).origin;
}

internalRoutes.post("/uploads", async (c) => {
  if (!isR2Configured()) {
    return c.json({ error: "Image storage is not configured on the server." }, 503);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "Expected a file upload." }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "No file received." }, 400);

  const ext = TYPES[file.type];
  if (!ext) return c.json({ error: "Images only — JPEG, PNG, WebP, GIF or AVIF." }, 415);
  if (file.size > MAX_BYTES) return c.json({ error: "That image is over 5 MB." }, 413);

  // Key comes from us, not the upload: no collisions, no traversal, no surprise
  // extension. Kept under its own prefix so blog images never sit among course
  // media, which is signed on every read and cleaned up on different rules.
  const key = `blog/${randomUUID()}.${ext}`;

  try {
    await putObject(key, await file.arrayBuffer(), file.type);
    // Not the bucket's public hostname: that answers 401, since public access is
    // off and the course video in the same bucket is why. Served through this
    // service instead — see http/media.ts.
    return c.json({ url: `${selfOrigin(c)}/media/blog/${key.slice("blog/".length)}` });
  } catch (err) {
    console.error("[internal/uploads] R2 upload failed", err);
    return c.json({ error: "Could not store the image." }, 502);
  }
});
