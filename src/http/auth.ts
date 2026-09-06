import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { env } from "../env.ts";
import { rateLimit } from "../rate-limit.ts";
import { sendSignInCode } from "../email/mailer.ts";
import { looksLikeEmail, normalizeEmail } from "../auth/crypto.ts";
import { createChallenge, verifyChallenge } from "../auth/otp.ts";
import { redeemHandoff } from "../auth/handoff.ts";
import { upsertUserByEmail } from "../auth/users.ts";
import { REFRESH_TTL, createSession, issueAccessToken, revokeSession, rotateSession } from "../auth/tokens.ts";

const REFRESH_COOKIE = "da_refresh";

/**
 * A readable companion to the httpOnly refresh cookie, carrying nothing but
 * the fact that a session exists.
 *
 * The marketing site uses it to decide whether to show the seminar popup to
 * someone who has already enrolled — a question it would otherwise have to
 * answer with a network call on every page load, for every anonymous visitor.
 * Advisory only: it is never checked for authorization, and forging it gains
 * nothing but a hidden popup.
 */
const HINT_COOKIE = "da_session";

/**
 * SameSite=Lax is enough here even though the API answers on its own subdomain:
 * api.deltaaiacademy.ai and deltaaiacademy.ai share a registrable domain, so
 * requests between them are same-site and the cookie rides along. Locally the
 * two are ports on localhost, which is likewise same-site.
 */
function setRefreshCookie(c: Parameters<typeof setCookie>[0], token: string) {
  setCookie(c, REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.isProduction(),
    sameSite: "Lax",
    domain: env.cookieDomain(),
    path: "/",
    maxAge: REFRESH_TTL,
  });
  setCookie(c, HINT_COOKIE, "1", {
    httpOnly: false,
    secure: env.isProduction(),
    sameSite: "Lax",
    domain: env.cookieDomain(),
    path: "/",
    maxAge: REFRESH_TTL,
  });
}

function clearAuthCookies(c: Parameters<typeof deleteCookie>[0]) {
  for (const name of [REFRESH_COOKIE, HINT_COOKIE]) {
    deleteCookie(c, name, { path: "/", domain: env.cookieDomain() });
  }
}

function requestInfo(c: { req: { header: (name: string) => string | undefined } }) {
  return {
    userAgent: c.req.header("User-Agent"),
    ip: c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? c.req.header("X-Real-IP"),
  };
}

function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return requestInfo(c).ip ?? "unknown";
}

export const authRoutes = new Hono();

/**
 * Asks for a sign-in code.
 *
 * Answers the same way whether or not the address has an account — otherwise
 * this endpoint becomes a way to test which of a list of emails are customers.
 * Two limits apply: a tight one per address, so nobody's inbox can be used as a
 * weapon, and a looser one per IP to blunt bulk enumeration.
 */
authRoutes.post("/otp/request", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail(String(body?.email ?? ""));
  if (!looksLikeEmail(email)) return c.json({ error: "Enter a valid email address" }, 400);

  const perEmail = rateLimit(`otp:email:${email}`, 3, 10 * 60_000);
  if (!perEmail.allowed) {
    return c.json(
      { error: "Too many codes requested. Try again shortly.", retryAfterSeconds: perEmail.retryAfterSeconds },
      429,
    );
  }
  const perIp = rateLimit(`otp:ip:${clientIp(c)}`, 20, 10 * 60_000);
  if (!perIp.allowed) {
    return c.json(
      { error: "Too many requests. Try again shortly.", retryAfterSeconds: perIp.retryAfterSeconds },
      429,
    );
  }

  const code = await createChallenge(email);
  const { sent } = await sendSignInCode(email, code);

  // Local convenience only, behind two gates: the code comes back in the
  // response so the flow can be exercised without a mailbox. Never in production.
  const echo = !env.isProduction() && process.env.OTP_ECHO === "1" ? { devCode: code } : {};
  return c.json({ ok: true, emailSent: sent, ...echo });
});

/** Exchanges a code for a session. Creates the account if this is a first
 *  sign-in — anyone may hold an account; what a payment unlocks is the video. */
authRoutes.post("/otp/verify", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail(String(body?.email ?? ""));
  const code = String(body?.code ?? "").trim();
  if (!looksLikeEmail(email) || !/^\d{6}$/.test(code)) {
    return c.json({ error: "Enter the six-digit code from your email" }, 400);
  }

  const limit = rateLimit(`verify:ip:${clientIp(c)}`, 30, 10 * 60_000);
  if (!limit.allowed) {
    return c.json({ error: "Too many attempts. Try again shortly.", retryAfterSeconds: limit.retryAfterSeconds }, 429);
  }

  const result = await verifyChallenge(email, code);
  if (result === "expired") return c.json({ error: "That code expired. Ask for a new one." }, 400);
  if (result === "too-many-attempts") return c.json({ error: "Too many wrong codes. Ask for a new one." }, 400);
  if (result !== "ok") return c.json({ error: "That code isn't right. Check it and try again." }, 400);

  const user = await upsertUserByEmail(email, {}, { touchLogin: true });

  const refresh = await createSession(user._id, requestInfo(c));
  setRefreshCookie(c, refresh);

  return c.json({
    accessToken: await issueAccessToken(user),
    user: { id: user._id.toHexString(), email: user.email, name: user.name, phone: user.phone, preferredLang: user.preferredLang },
  });
});

/** Rotates the refresh token and hands back a fresh access token. */
authRoutes.post("/refresh", async (c) => {
  const token = getCookie(c, REFRESH_COOKIE);
  if (!token) return c.json({ error: "Not signed in" }, 401);

  const result = await rotateSession(token, requestInfo(c));
  if (!result.ok) {
    clearAuthCookies(c);
    const message =
      result.reason === "reused"
        ? "Your session was signed out for safety. Sign in again."
        : "Your session expired — sign in again";
    return c.json({ error: message }, 401);
  }

  setRefreshCookie(c, result.token);
  return c.json({
    accessToken: await issueAccessToken(result.user),
    user: {
      id: result.user._id!.toHexString(),
      email: result.user.email,
      name: result.user.name,
      phone: result.user.phone,
      preferredLang: result.user.preferredLang,
    },
  });
});

authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, REFRESH_COOKIE);
  if (token) await revokeSession(token);
  clearAuthCookies(c);
  return c.json({ ok: true });
});

/**
 * Signs in the browser straight after a purchase, using the one-time ticket
 * /internal/grant issued.
 *
 * Failure here is deliberately soft: the entitlement is already recorded, so a
 * ticket that expired or was already spent means the buyer signs in with a code
 * instead of being stuck. The response says which, so the page can say
 * something useful rather than "error".
 */
authRoutes.post("/handoff", async (c) => {
  const body = await c.req.json().catch(() => null);
  const token = String(body?.token ?? "").trim();
  if (!token) return c.json({ error: "Missing token" }, 400);

  const limit = rateLimit(`handoff:ip:${clientIp(c)}`, 20, 10 * 60_000);
  if (!limit.allowed) {
    return c.json({ error: "Too many attempts. Try again shortly.", retryAfterSeconds: limit.retryAfterSeconds }, 429);
  }

  const user = await redeemHandoff(token);
  if (!user?._id) {
    return c.json({ error: "This sign-in link has already been used or expired. Sign in with your email." }, 401);
  }

  const refresh = await createSession(user._id, requestInfo(c));
  setRefreshCookie(c, refresh);

  return c.json({
    accessToken: await issueAccessToken(user),
    user: { id: user._id.toHexString(), email: user.email, name: user.name, phone: user.phone, preferredLang: user.preferredLang },
  });
});
