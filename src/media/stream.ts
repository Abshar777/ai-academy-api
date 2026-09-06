import { createSign } from "node:crypto";
import { env } from "../env.ts";

/**
 * Cloudflare Stream — segmented HLS delivery with signed, expiring playback
 * tokens, replacing the signed R2 file URLs.
 *
 * The gain over R2 is what a copied link is worth: an R2 URL hands over the
 * whole file for as long as its signature lasts, while a Stream token buys a
 * manifest that expires and cannot be handed to a downloader as a single file.
 *
 * Everything here returns null or throws rather than guessing when Stream
 * isn't configured; callers fall back to R2, so a half-finished migration
 * still plays.
 */

const API = "https://api.cloudflare.com/client/v4";

export function isStreamConfigured(): boolean {
  return env.stream() !== null;
}

export function canSignPlayback(): boolean {
  const config = env.stream();
  return Boolean(config?.signingKeyId && config?.signingKeyPem && config?.customerCode);
}

type CloudflareResponse<T> = {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
};

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = env.stream();
  if (!config) throw new Error("Cloudflare Stream is not configured");

  const response = await fetch(`${API}/accounts/${config.accountId}/stream${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });

  const body = (await response.json()) as CloudflareResponse<T>;
  if (!response.ok || !body.success) {
    const detail = body.errors?.map((e) => `${e.code} ${e.message}`).join("; ") || response.statusText;
    throw new Error(`Cloudflare Stream ${path} failed: ${detail}`);
  }
  return body.result;
}

// ------------------------------------------------------------------ uploads

export type StreamVideo = {
  uid: string;
  readyToStream: boolean;
  status?: { state?: string; pctComplete?: string; errorReasonText?: string };
  duration?: number;
  playback?: { hls?: string; dash?: string };
  meta?: Record<string, string>;
};

/**
 * Pulls a file straight from R2 rather than uploading bytes through here — the
 * originals are already in Cloudflare's network, so this never moves a
 * gigabyte through this process.
 *
 * `requireSignedURLs` from the moment it exists: a video that is briefly
 * public is a video that can be scraped.
 */
export async function copyFromUrl(sourceUrl: string, name: string): Promise<StreamVideo> {
  return call<StreamVideo>("/copy", {
    method: "POST",
    body: JSON.stringify({ url: sourceUrl, meta: { name }, requireSignedURLs: true }),
  });
}

export async function getVideo(uid: string): Promise<StreamVideo> {
  return call<StreamVideo>(`/${uid}`);
}

export async function deleteVideo(uid: string): Promise<void> {
  const config = env.stream();
  if (!config) throw new Error("Cloudflare Stream is not configured");
  await fetch(`${API}/accounts/${config.accountId}/stream/${uid}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${config.apiToken}` },
  });
}

// ------------------------------------------------------------- signing keys

export type SigningKey = { id: string; pem: string; jwk: string };

/** Created once. The private key comes back exactly this one time. */
export async function createSigningKey(): Promise<SigningKey> {
  return call<SigningKey>("/keys", { method: "POST", body: JSON.stringify({}) });
}

// ------------------------------------------------------------------ tokens

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * A playback token for one video, valid for `ttlSeconds`.
 *
 * Signed RS256 with the Stream signing key. Cloudflare hands back a
 * base64-wrapped PEM, so it is decoded before use.
 */
export function signPlaybackToken(uid: string, ttlSeconds: number): string {
  const config = env.stream();
  if (!config?.signingKeyId || !config.signingKeyPem) {
    throw new Error("Cloudflare Stream signing key is not configured");
  }

  const pem = config.signingKeyPem.includes("BEGIN")
    ? config.signingKeyPem
    : Buffer.from(config.signingKeyPem, "base64").toString("utf8");

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", kid: config.signingKeyId }));
  const payload = base64url(
    JSON.stringify({ sub: uid, kid: config.signingKeyId, exp: now + ttlSeconds, nbf: now - 30 }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${base64url(signer.sign(pem))}`;
}

/** The signed HLS manifest a player loads. */
export function hlsUrl(uid: string, ttlSeconds: number): string {
  const config = env.stream();
  if (!config?.customerCode) throw new Error("CF_STREAM_CUSTOMER_CODE is not set");
  const token = signPlaybackToken(uid, ttlSeconds);
  return `https://customer-${config.customerCode}.cloudflarestream.com/${token}/manifest/video.m3u8`;
}
