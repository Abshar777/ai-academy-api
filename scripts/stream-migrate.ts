/**
 * Moves the catalogue from R2 files to Cloudflare Stream.
 *
 *   bun run scripts/stream-migrate.ts --create-key   # once, prints the key
 *   bun run scripts/stream-migrate.ts                # dry run
 *   bun run scripts/stream-migrate.ts --write --limit 1
 *   bun run scripts/stream-migrate.ts --write
 *
 * Stream pulls each file straight from R2 over a signed URL, so nothing moves
 * through this process. `streamUid` is written only once Cloudflare reports the
 * video ready — until then the episode keeps serving its R2 original, so a run
 * that stops halfway leaves every episode playable.
 *
 * Re-running skips anything already migrated, so it is safe to repeat.
 */
import { getDb, closeDb } from "../src/db.ts";
import { EPISODES, type Episode, type Lang } from "../src/content/types.ts";
import { keyFromUrl, signGetUrl } from "../src/media/r2.ts";
import {
  copyFromUrl,
  createSigningKey,
  getVideo,
  isStreamConfigured,
  type StreamVideo,
} from "../src/media/stream.ts";

const WRITE = Bun.argv.includes("--write");
const CREATE_KEY = Bun.argv.includes("--create-key");
const limitArg = Bun.argv.indexOf("--limit");
const LIMIT = limitArg === -1 ? Infinity : Number(Bun.argv[limitArg + 1]) || Infinity;

/** Long enough for Cloudflare to pull a 25-minute file, and it is used once. */
const SOURCE_URL_TTL = 6 * 60 * 60;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 20 * 60 * 1000;
const CONCURRENCY = 3;

if (!isStreamConfigured()) {
  console.error("\n  CF_STREAM_API_TOKEN is not set. Create a token with Stream:Edit at");
  console.error("  dash.cloudflare.com > My Profile > API Tokens, then put it in .env.\n");
  process.exit(1);
}

// ------------------------------------------------------------- signing key
if (CREATE_KEY) {
  const key = await createSigningKey();
  console.log("\n  Signing key created. The private key is shown once — copy both lines into .env:\n");
  console.log(`CF_STREAM_SIGNING_KEY_ID=${key.id}`);
  console.log(`CF_STREAM_SIGNING_KEY_PEM=${key.pem}\n`);
  process.exit(0);
}

// ------------------------------------------------------------------ work
const db = await getDb();
const episodes = await db.collection<Episode>(EPISODES).find({}).sort({ order: 1 }).toArray();

type Job = { episodeId: string; key: string; lang: Lang; url: string; name: string };
const jobs: Job[] = [];
let alreadyDone = 0;

for (const episode of episodes) {
  for (const [lang, media] of Object.entries(episode.media)) {
    if (media.streamUid) { alreadyDone++; continue; }
    jobs.push({
      episodeId: episode._id!.toHexString(),
      key: episode.key,
      lang: lang as Lang,
      url: media.url,
      name: `${episode.key} [${lang}] ${episode.title.en}`.slice(0, 90),
    });
  }
}

const queue = jobs.slice(0, LIMIT === Infinity ? jobs.length : LIMIT);

console.log(`\n  ${jobs.length + alreadyDone} video files · ${alreadyDone} already on Stream · ${queue.length} to migrate`);
if (!WRITE) {
  console.log("\n  Dry run — nothing uploaded. Re-run with --write.\n");
  for (const job of queue.slice(0, 10)) console.log(`    ${job.name}`);
  if (queue.length > 10) console.log(`    … and ${queue.length - 10} more`);
  console.log();
  await closeDb();
  process.exit(0);
}

/** Polls until Cloudflare finishes encoding, or gives up so one stuck file
 *  can't hold the whole run. */
async function waitForReady(uid: string): Promise<StreamVideo> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const video = await getVideo(uid);
    if (video.readyToStream) return video;
    if (video.status?.state === "error") {
      throw new Error(video.status.errorReasonText ?? "Cloudflare reported an encoding error");
    }
    if (Date.now() > deadline) throw new Error(`still ${video.status?.state ?? "pending"} after 20 minutes`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

let migrated = 0;
let failed = 0;
let customerCode = "";

const pending = [...queue];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
    for (let job = pending.shift(); job; job = pending.shift()) {
      try {
        const objectKey = keyFromUrl(job.url);
        if (!objectKey) throw new Error("not an R2 URL we host");

        const signed = await signGetUrl(objectKey, SOURCE_URL_TTL);
        const created = await copyFromUrl(signed, job.name);
        const ready = await waitForReady(created.uid);

        // Written only now — an episode with a uid but no playable video would
        // be worse than one still serving R2.
        await db.collection<Episode>(EPISODES).updateOne(
          { _id: new (await import("mongodb")).ObjectId(job.episodeId) },
          { $set: { [`media.${job.lang}.streamUid`]: ready.uid, updatedAt: new Date() } },
        );

        if (!customerCode && ready.playback?.hls) {
          customerCode = ready.playback.hls.match(/customer-([a-z0-9]+)\./i)?.[1] ?? "";
        }
        migrated++;
        console.log(`  ✓ ${job.name}  →  ${ready.uid}`);
      } catch (err) {
        failed++;
        console.error(`  ✗ ${job.name}  —  ${err instanceof Error ? err.message : err}`);
      }
    }
  }),
);

console.log(`\n  ${migrated} migrated · ${failed} failed`);
if (customerCode) {
  console.log(`\n  Set this in .env so playback URLs can be built:\n    CF_STREAM_CUSTOMER_CODE=${customerCode}`);
}
console.log();
await closeDb();
