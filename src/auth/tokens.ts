import { ObjectId } from "mongodb";
import { sign, verify } from "hono/jwt";
import { getDb } from "../db.ts";
import { env } from "../env.ts";
import { hash, randomToken } from "./crypto.ts";
import { SESSIONS, USERS, type Session, type User } from "./types.ts";

/** Short, because it can't be revoked — the refresh token is what actually
 *  controls how long someone stays signed in. */
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_DAYS = 30;

/**
 * How long a just-rotated refresh token still answers.
 *
 * Two page loads in quick succession each ask for a session, and both can be
 * in flight before either one's Set-Cookie lands — so the second arrives
 * holding a token the first has already rotated away. That is one browser
 * racing itself, not a stolen token being replayed, and treating it as theft
 * signed people out for navigating quickly.
 *
 * A replay this far after the fact is still treated as theft and still kills
 * the whole chain; the leeway only covers the seconds either side of a
 * rotation, which is the window a race can occupy.
 */
const REUSE_LEEWAY_MS = 30_000;

export type AccessPayload = { sub: string; email: string; exp: number };

/** Pinned explicitly on both sides. Letting the token declare its own algorithm
 *  is how "alg: none" and HMAC/RSA confusion attacks get in. */
const ALG = "HS256" as const;

export async function issueAccessToken(user: User): Promise<string> {
  return sign(
    {
      sub: user._id!.toHexString(),
      email: user.email,
      exp: Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS,
    },
    env.authSecret(),
    ALG,
  );
}

export async function readAccessToken(token: string): Promise<AccessPayload | null> {
  try {
    const payload = await verify(token, env.authSecret(), ALG);
    return payload as unknown as AccessPayload;
  } catch {
    return null;
  }
}

export const ACCESS_TTL = ACCESS_TTL_SECONDS;
export const REFRESH_TTL = REFRESH_TTL_DAYS * 24 * 60 * 60;

type RequestInfo = { userAgent?: string; ip?: string };

/** Starts a new chain. Returns the raw token — the only time it exists in
 *  plaintext; the database only ever holds its HMAC. */
export async function createSession(
  userId: ObjectId,
  info: RequestInfo,
  family = randomToken(),
): Promise<string> {
  const db = await getDb();
  const token = randomToken();
  await db.collection<Session>(SESSIONS).insertOne({
    userId,
    tokenHash: hash(token),
    family,
    userAgent: info.userAgent,
    ip: info.ip,
    expiresAt: new Date(Date.now() + REFRESH_TTL * 1000),
    revokedAt: null,
    createdAt: new Date(),
  });
  return token;
}

export type RotateResult =
  | { ok: true; user: User; token: string }
  | { ok: false; reason: "unknown" | "expired" | "reused" };

/**
 * Exchanges a refresh token for a fresh one and revokes the old.
 *
 * Presenting an already-revoked token means two parties hold the same one, and
 * only one of them should — so the entire chain is revoked rather than just
 * that link. The legitimate user is signed out too, which is the correct
 * outcome: better a re-login than a live session someone else can also use.
 */
export async function rotateSession(rawToken: string, info: RequestInfo): Promise<RotateResult> {
  const db = await getDb();
  const sessions = db.collection<Session>(SESSIONS);
  const session = await sessions.findOne({ tokenHash: hash(rawToken) });

  if (!session) return { ok: false, reason: "unknown" };

  if (session.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };

  if (session.revokedAt) {
    const sinceRotation = Date.now() - session.revokedAt.getTime();
    if (sinceRotation > REUSE_LEEWAY_MS) {
      // Long after the fact: someone kept a copy. Kill the chain.
      await sessions.updateMany(
        { family: session.family, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      );
      return { ok: false, reason: "reused" };
    }
    // Inside the leeway — fall through and issue a fresh token in the same
    // family, exactly as if this had been the live one.
  }

  const user = await db.collection<User>(USERS).findOne({ _id: session.userId });
  if (!user) return { ok: false, reason: "unknown" };

  await sessions.updateOne({ _id: session._id }, { $set: { revokedAt: new Date() } });
  const token = await createSession(session.userId, info, session.family);
  return { ok: true, user, token };
}

export async function revokeSession(rawToken: string): Promise<void> {
  const db = await getDb();
  await db
    .collection<Session>(SESSIONS)
    .updateOne({ tokenHash: hash(rawToken), revokedAt: null }, { $set: { revokedAt: new Date() } });
}
