/**
 * Proves the presigned URLs are actually valid, independent of whether the
 * bucket is still public.
 *
 * The public r2.dev domain serves everything to everyone right now, so
 * fetching a signed URL from *there* proves nothing. These requests go to the
 * S3 API endpoint instead, which always requires a signature — so an
 * unsigned request must be refused and a signed one must succeed. That is the
 * behaviour the bucket will have for everyone once public access is off.
 */
import { getDb, closeDb } from "../src/db.ts";
import { EPISODES, type Episode } from "../src/content/types.ts";
import { env } from "../src/env.ts";
import { isR2Configured, keyFromUrl, signGetUrl } from "../src/media/r2.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  — ${detail}` : ""}`); }
};

console.log("\n  R2 playback signing\n");
check("R2 credentials are configured", isR2Configured());
if (!isR2Configured()) { console.log(); process.exit(1); }

const config = env.r2()!;
const db = await getDb();
const episode = await db.collection<Episode>(EPISODES).findOne({ isFree: false });
const stored = episode?.media.en?.url ?? episode?.media.ml?.url;
if (!stored) throw new Error("no episode with a video to test against");

const key = keyFromUrl(stored);
check("the object key is recovered from the stored URL", key === stored.replace(`${config.publicUrl}/`, ""), String(key));
check("a URL we don't host is passed through untouched",
  keyFromUrl("https://example.com/video.mp4") === null);
check("a query string is not part of the key",
  keyFromUrl(`${config.publicUrl}/videos/a.mp4?x=1`) === "videos/a.mp4");
check("percent-encoding is decoded, like the LMS does",
  keyFromUrl(`${config.publicUrl}/videos/my%20file.mp4`) === "videos/my file.mp4");
// The traversal guard the LMS applies exists for the *encoded* form: `new URL`
// resolves a plain "../" away while parsing, but leaves "%2e%2e%2f" alone, so
// the "..' only appears after decodeURIComponent — which is exactly where the
// check sits.
check("an encoded traversal attempt is refused",
  keyFromUrl(`${config.publicUrl}/videos/%2e%2e%2f%2e%2e%2fsecret.mp4`) === null,
  String(keyFromUrl(`${config.publicUrl}/videos/%2e%2e%2f%2e%2e%2fsecret.mp4`)));
// A plain "../" is normalised by the URL parser into an ordinary key. R2 keys
// are flat strings rather than a filesystem, so that addresses a different
// object name, not a directory outside the bucket.
check("a plain ../ normalises to a flat key rather than escaping",
  keyFromUrl(`${config.publicUrl}/videos/../../etc/passwd`) === "etc/passwd");
check("junk is refused", keyFromUrl("not-a-url") === null);

// Range request: enough to prove access without pulling a whole video.
const range = { headers: { Range: "bytes=0-1023" } };
const endpoint = `https://${config.bucket}.${config.accountId}.r2.cloudflarestorage.com/${key}`;

// R2 answers an unsigned request with 400 InvalidArgument rather than the 401
// or 403 an S3 bucket would give, so this asserts what matters — refused, and
// no video came back — instead of pinning a status code.
const unsigned = await fetch(endpoint, range);
const unsignedBody = await unsigned.text();
check("the S3 endpoint refuses an unsigned request",
  !unsigned.ok && !(unsigned.headers.get("content-type") ?? "").includes("video"),
  `${unsigned.status} ${unsignedBody.slice(0, 60)}`);

const signedUrl = await signGetUrl(key!, 300);
const signed = await fetch(signedUrl, range);
check("the same object opens with a signature", signed.ok || signed.status === 206, `got ${signed.status}`);
check("it addresses the bucket the way the LMS does (virtual-hosted)",
  new URL(signedUrl).host === `${config.bucket}.${config.accountId}.r2.cloudflarestorage.com`,
  new URL(signedUrl).host);
check("it returns actual video bytes",
  (signed.headers.get("content-type") ?? "").includes("video") || Number(signed.headers.get("content-length")) > 0,
  signed.headers.get("content-type") ?? "");

// A signature has to stop being useful, or sharing the link is the same as
// making the object public.
const shortLived = await signGetUrl(key!, 60);
check("the URL carries an expiry", shortLived.includes("X-Amz-Expires=60"));
check("and a signature", shortLived.includes("X-Amz-Signature="));

const tampered = signedUrl.replace(/X-Amz-Signature=[0-9a-f]+/, "X-Amz-Signature=" + "0".repeat(64));
const tamperedRes = await fetch(tampered, range);
check("a tampered signature is rejected", !tamperedRes.ok, `got ${tamperedRes.status}`);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
await closeDb();
process.exit(fail ? 1 : 0);
