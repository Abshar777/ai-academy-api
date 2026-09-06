import { getDb } from "../db.ts";
import { hash, matches, randomCode } from "./crypto.ts";
import { OTPS, type OtpChallenge } from "./types.ts";

const TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

/**
 * Issues a code, invalidating any still outstanding for the address — so
 * asking for a second code reliably makes the first one dead, rather than
 * leaving several valid at once.
 */
export async function createChallenge(email: string): Promise<string> {
  const db = await getDb();
  const otps = db.collection<OtpChallenge>(OTPS);
  const now = new Date();

  await otps.updateMany({ email, consumedAt: null }, { $set: { consumedAt: now } });

  const code = randomCode();
  await otps.insertOne({
    email,
    codeHash: hash(code),
    attempts: 0,
    expiresAt: new Date(now.getTime() + TTL_MINUTES * 60_000),
    consumedAt: null,
    createdAt: now,
  });
  return code;
}

export type VerifyResult = "ok" | "invalid" | "expired" | "too-many-attempts";

/**
 * The attempt counter increments before the code is compared, so a wrong guess
 * costs an attempt whether or not the request completes. Five wrong guesses
 * against a million possibilities is not a meaningful chance.
 */
export async function verifyChallenge(email: string, code: string): Promise<VerifyResult> {
  const db = await getDb();
  const otps = db.collection<OtpChallenge>(OTPS);

  const challenge = await otps.findOne({ email, consumedAt: null }, { sort: { createdAt: -1 } });
  if (!challenge) return "invalid";
  if (challenge.expiresAt.getTime() < Date.now()) return "expired";
  if (challenge.attempts >= MAX_ATTEMPTS) return "too-many-attempts";

  const bumped = await otps.findOneAndUpdate(
    { _id: challenge._id, attempts: { $lt: MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { returnDocument: "after" },
  );
  if (!bumped) return "too-many-attempts";

  if (!matches(code, bumped.codeHash)) return "invalid";

  await otps.updateOne({ _id: bumped._id }, { $set: { consumedAt: new Date() } });
  return "ok";
}
