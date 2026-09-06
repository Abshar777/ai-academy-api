import { getDb } from "./db.ts";
import { COURSES, EPISODES, MODULES, PROGRESS } from "./content/types.ts";
import { ENTITLEMENTS, HANDOFFS, OTPS, SESSIONS, USERS } from "./auth/types.ts";

/**
 * Created once at boot. Two of these are correctness, not performance: the
 * unique index on `entitlements.orderRef` is what makes granting access
 * idempotent when a payment webhook retries, and the unique index on
 * `users.email` is what stops two sign-ins racing into two accounts.
 *
 * The TTL indexes let Mongo expire spent codes and sessions on its own, so
 * nothing has to sweep them.
 */
export async function ensureIndexes(): Promise<void> {
  const db = await getDb();

  await Promise.all([
    db.collection(COURSES).createIndex({ slug: 1 }, { unique: true }),
    db.collection(MODULES).createIndex({ courseId: 1, order: 1 }, { unique: true }),
    db.collection(EPISODES).createIndex({ moduleId: 1, key: 1 }, { unique: true }),
    db.collection(EPISODES).createIndex({ courseId: 1 }),

    // One row per person per episode — the upsert on save depends on it.
    db.collection(PROGRESS).createIndex({ userId: 1, episodeId: 1 }, { unique: true }),
    db.collection(PROGRESS).createIndex({ userId: 1, updatedAt: -1 }),

    db.collection(USERS).createIndex({ email: 1 }, { unique: true }),

    db.collection(OTPS).createIndex({ email: 1, createdAt: -1 }),
    db.collection(OTPS).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),

    db.collection(SESSIONS).createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection(SESSIONS).createIndex({ userId: 1 }),
    db.collection(SESSIONS).createIndex({ family: 1 }),
    db.collection(SESSIONS).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),

    db.collection(HANDOFFS).createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection(HANDOFFS).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),

    db.collection(ENTITLEMENTS).createIndex({ orderRef: 1 }, { unique: true }),
    db.collection(ENTITLEMENTS).createIndex({ userId: 1, courseId: 1 }),
  ]);
}
