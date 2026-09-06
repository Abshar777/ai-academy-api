import type { ObjectId } from "mongodb";
import { getDb } from "../db.ts";
import { hash, randomToken } from "./crypto.ts";
import { HANDOFFS, USERS, type Handoff, type User } from "./types.ts";

/** Long enough to survive a payment redirect and a slow page load, short enough
 *  that a token left in browser history is worthless by the time anyone finds it. */
const TTL_MINUTES = 5;

export async function createHandoff(userId: ObjectId): Promise<string> {
  const db = await getDb();
  const token = randomToken();
  await db.collection<Handoff>(HANDOFFS).insertOne({
    userId,
    tokenHash: hash(token),
    expiresAt: new Date(Date.now() + TTL_MINUTES * 60_000),
    consumedAt: null,
    createdAt: new Date(),
  });
  return token;
}

/**
 * Consumes the ticket and returns whose it was.
 *
 * The consume is a conditional update rather than a read-then-write, so two
 * requests arriving together — a double-submit, or a page that mounts twice in
 * React's strict mode — can't both succeed.
 */
export async function redeemHandoff(rawToken: string): Promise<User | null> {
  const db = await getDb();
  const claimed = await db.collection<Handoff>(HANDOFFS).findOneAndUpdate(
    { tokenHash: hash(rawToken), consumedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { consumedAt: new Date() } },
  );
  if (!claimed) return null;
  return db.collection<User>(USERS).findOne({ _id: claimed.userId });
}
