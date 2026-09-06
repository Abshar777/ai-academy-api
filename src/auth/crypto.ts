import { timingSafeEqual } from "node:crypto";
import { env } from "../env.ts";

/**
 * Codes and refresh tokens are stored as an HMAC keyed on AUTH_SECRET, not a
 * bare hash. A six-digit code has only a million possibilities, so a plain
 * SHA-256 of one is reversible by anyone who reads the database; keyed, it is
 * useless without the secret too.
 */
export function hash(value: string): string {
  return new Bun.CryptoHasher("sha256", env.authSecret()).update(value).digest("hex");
}

/** Constant-time comparison, so a wrong code can't be narrowed down by timing. */
export function matches(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hash(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Six digits, uniformly distributed. Math.random is not used anywhere a
 *  guessable value would let someone into an account. */
export function randomCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0]! % 1_000_000).padStart(6, "0");
}

export function randomToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString("base64url");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Deliberately loose: the mail either arrives or it doesn't, and an overly
 *  strict pattern rejects valid addresses. */
export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}
