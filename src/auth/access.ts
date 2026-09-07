import type { ObjectId } from "mongodb";
import { getDb } from "../db.ts";
import { ENTITLEMENTS, type Entitlement } from "./types.ts";

/** Whether this user has paid for this course. Entitlements are written by the
 *  purchase bridge (phase 3); until then only free episodes open. */
export async function hasEntitlement(userId: ObjectId, courseId: ObjectId): Promise<boolean> {
  const db = await getDb();
  const found = await db.collection<Entitlement>(ENTITLEMENTS).findOne({ userId, courseId });
  return found !== null;
}

export async function listEntitlements(userId: ObjectId): Promise<Entitlement[]> {
  const db = await getDb();
  return db.collection<Entitlement>(ENTITLEMENTS).find({ userId }).toArray();
}

/** Whether this user has bought anything at all. Sign-in is gated on this: the
 *  course area is for buyers, so an email with no entitlement can't hold a
 *  session (the free preview lives on the public marketing pages instead). */
export async function hasAnyEntitlement(userId: ObjectId): Promise<boolean> {
  const db = await getDb();
  const found = await db.collection<Entitlement>(ENTITLEMENTS).findOne({ userId });
  return found !== null;
}

/**
 * Records that a payment bought a course. Idempotent on `orderRef`, which is
 * the payment id — a webhook that retries, or a browser callback racing the
 * webhook, grants once.
 *
 * Returns whether this call was the one that created it, so callers can fire
 * one-time side effects without double-firing them.
 */
export async function grantAccess(input: {
  userId: ObjectId;
  courseId: ObjectId;
  source: Entitlement["source"];
  orderRef: string;
}): Promise<{ created: boolean }> {
  const db = await getDb();
  try {
    const result = await db.collection<Entitlement>(ENTITLEMENTS).updateOne(
      { orderRef: input.orderRef },
      { $setOnInsert: { ...input, grantedAt: new Date() } },
      { upsert: true },
    );
    return { created: result.upsertedCount > 0 };
  } catch (err) {
    // The unique index fired, meaning a concurrent call won the race. That is
    // the index doing its job, not a failure.
    if (typeof err === "object" && err !== null && (err as { code?: number }).code === 11000) {
      return { created: false };
    }
    throw err;
  }
}
