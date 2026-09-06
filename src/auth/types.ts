import type { ObjectId } from "mongodb";
import type { Lang } from "../content/types.ts";

export type User = {
  _id?: ObjectId;
  /** Lowercased and trimmed on the way in — the unique index depends on it. */
  email: string;
  name?: string;
  phone?: string;
  country?: string;
  /** Which language the course view opens in. Stored on the user rather than in
   *  a cookie so the choice follows them between devices. */
  preferredLang: Lang;
  createdAt: Date;
  lastLoginAt?: Date;
};

/**
 * One outstanding sign-in code. Removed by a TTL index once it expires, so old
 * codes don't accumulate and a stale one can never be replayed.
 */
export type OtpChallenge = {
  _id?: ObjectId;
  email: string;
  /** HMAC of the code, not the code — see auth/crypto.ts. */
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  consumedAt?: Date | null;
  createdAt: Date;
};

/**
 * A refresh token, stored hashed. Every refresh rotates it: the old row is
 * revoked and a new one issued. `family` ties the chain together, so if a
 * revoked token is ever presented again — meaning someone kept a copy — the
 * whole chain can be killed at once rather than just that link.
 */
export type Session = {
  _id?: ObjectId;
  userId: ObjectId;
  tokenHash: string;
  family: string;
  userAgent?: string;
  ip?: string;
  expiresAt: Date;
  revokedAt?: Date | null;
  createdAt: Date;
};

/** What a payment bought. Written by the purchase bridge in phase 3. */
export type Entitlement = {
  _id?: ObjectId;
  userId: ObjectId;
  courseId: ObjectId;
  source: "razorpay" | "abzer" | "coupon" | "manual";
  /** Payment or order id — unique, so a webhook retry can't grant twice. */
  orderRef: string;
  grantedAt: Date;
};

/**
 * A one-time ticket that turns a completed purchase into a signed-in browser.
 *
 * Short-lived and single-use because it travels in a URL, where it can end up
 * in history, a referrer header, or a screenshot. Losing it costs nothing: the
 * entitlement is already recorded, so the buyer can always sign in with a code
 * instead.
 */
export type Handoff = {
  _id?: ObjectId;
  userId: ObjectId;
  tokenHash: string;
  expiresAt: Date;
  consumedAt?: Date | null;
  createdAt: Date;
};

export const USERS = "users";
export const HANDOFFS = "handoffs";
export const OTPS = "otps";
export const SESSIONS = "sessions";
export const ENTITLEMENTS = "entitlements";
