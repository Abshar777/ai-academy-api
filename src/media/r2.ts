import { AwsClient } from "aws4fetch";
import { env } from "../env.ts";

/**
 * Turns a stored public video URL into a short-lived signed one.
 *
 * The videos live in the same R2 bucket the LMS uses, and the LMS already
 * serves its lessons through presigned URLs, so switching the bucket to
 * private breaks neither service. Until someone actually turns off public
 * access in Cloudflare, signing changes nothing an attacker can't route
 * around — see the deployment note in the README.
 *
 * aws4fetch rather than the AWS SDK: signing a GET is the only thing needed
 * here, and it costs about ten kilobytes instead of several megabytes.
 */

let client: AwsClient | null = null;

function getClient(): AwsClient | null {
  const config = env.r2();
  if (!config) return null;
  if (!client) {
    client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: "auto",
    });
  }
  return client;
}

export function isR2Configured(): boolean {
  return env.r2() !== null;
}

/**
 * Recovers the object key from a URL this service stored earlier.
 *
 * Mirrors the LMS's own `keyFromUrl` (backend/src/services/r2.service.ts) —
 * same decoding, the same `uploads/` prefix handling for local-disk-style
 * paths, and the same refusal of any key containing `..`, since the key is
 * used to address storage.
 *
 * One deliberate difference: the LMS derives a key from *any* URL, so an
 * externally-hosted lesson video becomes a bogus key it then signs against our
 * bucket. This checks the origin first and returns null for anything we don't
 * host, which the caller passes through untouched — the behaviour the LMS's own
 * comment describes but its code doesn't implement.
 */
export function keyFromUrl(url: string): string | null {
  if (!url) return null;
  const config = env.r2();
  if (!config) return null;

  let parsed: URL;
  let ours: URL;
  try {
    parsed = new URL(url);
    ours = new URL(config.publicUrl);
  } catch {
    return null;
  }
  if (parsed.origin !== ours.origin) return null;

  const decoded = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
  const key = decoded.startsWith("uploads/") ? decoded.slice("uploads/".length) : decoded;
  if (!key || key.includes("..")) return null;
  return key;
}

/** A presigned GET, valid for `ttlSeconds`. */
export async function signGetUrl(key: string, ttlSeconds: number): Promise<string> {
  const config = env.r2();
  const aws = getClient();
  if (!config || !aws) throw new Error("R2 is not configured");

  // Virtual-hosted style — bucket as a subdomain — matching what the LMS's
  // AWS SDK produces for the same object. R2 accepts path style too, but
  // keeping one form across both services means one thing to reason about.
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const endpoint = `https://${config.bucket}.${config.accountId}.r2.cloudflarestorage.com/${encodedKey}`;

  const signed = await aws.sign(
    new Request(`${endpoint}?X-Amz-Expires=${ttlSeconds}`, { method: "GET" }),
    { aws: { signQuery: true } },
  );
  return signed.url;
}

/**
 * The URL to hand a player. Signs what we host; passes anything else straight
 * through, so a lesson pointing at an external video still plays.
 *
 * Never throws — a signing failure falls back to the stored URL rather than
 * breaking playback, and is logged so it doesn't pass silently.
 */
export async function playbackUrl(url: string): Promise<string> {
  const key = keyFromUrl(url);
  if (!key) return url;
  try {
    return await signGetUrl(key, env.videoUrlTtl());
  } catch (err) {
    console.error("[r2] Failed to sign playback URL, falling back to the stored one", err);
    return url;
  }
}
