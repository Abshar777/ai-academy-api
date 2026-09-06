# academy-api

Backend for the Delta AI Academy course platform. Runs on Bun, writes to the
same `ai_academy` MongoDB database the marketing site
(`../ai-academy-v2`) already uses for enrollments — so a purchase and the
access it grants live in one place.

## Phase 1 — content import (done)

Folds the two exported LMS courses, "Ai Academy English" (33 lessons) and
"AI Academy - Malayalam" (41), into one bilingual course of **34 episodes, 28
of them in both languages**.

```bash
bun run scripts/import-content.ts --en <english.json> --ml <malayalam.json>
```

Dry run by default — prints the full pairing table and writes nothing. Add
`--write` to commit. The write upserts on `(moduleId, key)` and deletes
episodes whose key no longer appears, so re-running after a rule change
converges instead of leaving orphans.

Flags: `--skip-probe` (skip ffprobe, leave durations unknown),
`--trust-identical` (see below).

### Where the pairing comes from

`scripts/pairing.ts` holds every judgement call, as data rather than
heuristics — a 74-lesson catalogue matched by fuzzy title similarity would be
impossible to check, whereas an explicit list can be read line by line.

- **Modules 1, 2, 4** pair on the `ep-N` in each lesson title.
- **Module 3** numbers nothing on either side, so `MODULE_3` maps the pairs by
  topic using exact source titles.
- `DROPPED` removes five redundant Malayalam uploads, each confirmed by probing
  the video and finding the runtime matches its numbered twin to the second.
- `ALIASES` redirects Malayalam files that belong to a numbered episode but were
  saved under a working filename.

Any lesson no rule claims is reported as `!! UNCLAIMED` rather than dropped —
the map is not allowed to lose content quietly.

Every `DROPPED` entry carries the evidence for dropping it, most as a
correlation score (see below) rather than a judgement about the filename.

### Durations come from the files

The exported `durationMins` are unreliable: English module 1 reports one minute
per episode against recordings running up to 25. The import reads the real
length out of each file's container with `ffprobe`, which fetches only the
header, and caches results in `.cache/` between runs.

### Six Malayalam entries hold no Malayalam

The lesson counts are not the whole story. Eleven Malayalam rows were set aside,
and six of them matter:

- **Five module 2 episodes** (ep-2, ep-5, ep-9, and the original ep-4 and ep-7
  rows) are the *English* video filed into the Malayalam course.
- **`ai-designs`** in module 3 is module 2's opening episode, misfiled.

None of that is visible in the titles or the durations alone, so it was settled
by measurement — see below. For ep-4 and ep-7 the real Malayalam recording did
exist under a working filename, and `ALIASES` promotes it; ep-2, ep-5 and ep-9
have no Malayalam recording at all and are honestly marked English-only.

### How the pairing was verified

Two audio measurements, both re-runnable:

```bash
bun run scripts/validate-pairs.ts    # every imported pair, straight from the database
bun run scripts/audio-compare.ts --en <en.json> --ml <ml.json>
bun run scripts/speech-check.ts  --en <en.json> --ml <ml.json>
```

`validate-pairs` correlates the loudness envelopes of the two audio tracks on
every episode claiming both languages. Speech drives volume up and down in a
pattern that survives re-encoding, so two encodes of one take score **1.000**
while the same screencast narrated twice scores near zero. Across all 28 pairs
the highest is **0.189** — comfortably separated, with known duplicates scoring
1.000 as a control.

`speech-check` measures how much of a file sits near silence. It exists because
the `_bgm-only` filenames read as "background music, no voice", which would have
made those files useless as a Malayalam track. They pause for ~25% of their
runtime, matching confirmed narrated files, so the name is misleading and the
audio is fine.

The import also refuses to trust identical runtimes on its own: any episode
whose two languages run to exactly the same length is withheld and reported.
`--trust-identical` overrides that once someone has listened.

## Phase 2 — the API (done)

```bash
bun run dev          # watch mode on :6112
bun run test:api     # 32 checks against a running server
bun run check:smtp   # proves the mail credentials work, sends nothing
```

Hono on Bun. Indexes are created at boot and a failure there is fatal on
purpose — two of them are what make granting access idempotent and sign-in
single-account, so running without them would look fine and quietly corrupt
data.

### Endpoints

| | | |
|---|---|---|
| `GET`   | `/health`               | pings Mongo, not just the process |
| `POST`  | `/auth/otp/request`     | emails a code; always 200 |
| `POST`  | `/auth/otp/verify`      | code → session, creating the account if new |
| `POST`  | `/auth/refresh`         | rotates the refresh token |
| `POST`  | `/auth/logout`          | revokes this session |
| `GET`   | `/me`                   | who is signed in, and what they can open |
| `PATCH` | `/me`                   | preferred language |
| `GET`   | `/courses/:slug`        | full contents, public, no video URLs |
| `GET`   | `/episodes/:id/play`    | playback URLs, access checked |
| `PUT`   | `/progress/:episodeId`  | saves where someone got to |
| `GET`   | `/episodes/free`        | the free episode, signed, no account needed |

### How sign-in is protected

- **No user enumeration.** `/auth/otp/request` answers identically whether or
  not the address has an account, so it can't be used to test a list of emails
  against the customer base.
- **Codes are peppered, not just hashed.** A six-digit code has a million
  possibilities, so a plain SHA-256 of one is reversible by anyone who reads the
  database. Codes and refresh tokens are stored as an HMAC keyed on
  `AUTH_SECRET`, which is not in the database.
- **Five attempts**, counted before the comparison, so a wrong guess costs an
  attempt whether or not the request finishes. Asking for a new code kills the
  old one.
- **Refresh tokens rotate**, and presenting a revoked one revokes the entire
  chain — if two parties hold the same token, only one should, and a forced
  re-login is the cheaper outcome.
- **The JWT algorithm is pinned** on both sign and verify. Letting a token
  declare its own is how `alg: none` and HMAC/RSA confusion get in.
- **Rate limited** per address and per IP.

Anyone may hold an account; what a payment unlocks is the video. Someone who
paid under a different address gets a clear message instead of a dead end.

### What the paywall does not yet cover

`/episodes/:id/play` checks entitlement before handing back a URL, but the files
are on a public bucket — that URL works for anyone who gets hold of it. Phase 5
swaps in signed, expiring URLs behind this same route, so callers won't change.

Entitlements are written in phase 3, so today only the free episode opens.

## Phase 3 — purchase grants access (done)

A completed payment now creates the buyer's account, records what they bought,
and hands back a one-time ticket that signs their browser in.

| | | |
|---|---|---|
| `POST` | `/internal/grant`  | server-to-server; account + entitlement + ticket |
| `POST` | `/auth/handoff`    | redeems the ticket for a session |

The marketing site calls it through `lib/course-access.ts`, from all four paths
that can complete an enrolment: the Razorpay browser callback, the Razorpay
webhook, the Abzer webhook, and free coupon redemption.

### Granting exactly once

`orderRef` is the payment id, prefixed with its gateway — `razorpay:pay_…`,
`abzer:<uuid>`, `coupon:<code>:<email>` — and carries a unique index. A webhook
retry, or the browser callback racing the webhook, produces one entitlement.

The Razorpay browser path grants *before* it checks whether it was the one to
record the enrolment. The webhook may well have recorded it already, but this is
the buyer sitting on the page right now, and they still need a ticket. A repeat
call therefore always returns a fresh ticket even when it grants nothing.

### When it fails

Every call is best-effort, with a 5s timeout. The payment has already succeeded
by the time any of this runs, so an unreachable API must not turn a captured
payment into an error — it logs and the enrolment stands. The buyer signs in
with an emailed code instead, and finds the course already unlocked, because:

```bash
bun run scripts/backfill-entitlements.ts            # dry run
bun run scripts/backfill-entitlements.ts --write    # grant
```

reads the site's `enrollments` ledger and grants anyone the bridge missed. It
builds `orderRef` exactly as the live paths do, so a row it grants and a webhook
that later replays the same payment collapse onto one entitlement.

### The ticket

Single-use and valid for five minutes, because it travels in a URL where it can
end up in history or a screenshot. The consume is a conditional update, not a
read-then-write, so a double-submit can't spend it twice. Losing it costs
nothing — the entitlement is already recorded.

The API contract is finished and tested; the site does not yet carry the ticket
to a landing page, because there is nowhere to land until `/learn` exists in
phase 4.

## Phase 4 — the course view (done)

Lives in the marketing site at `/learn`, not in a separate app, so the whole
thing is one deploy and one domain.

- `app/learn/page.tsx` — contents, progress, resume, locked state
- `app/learn/[module]/[episode]/page.tsx` — player, language toggle, module contents
- `components/academy-auth.tsx` — session provider, mounted only under `/learn`
- `components/learn/*` — sign-in, language toggle, episode rows

Episodes are addressed as `/learn/2/ep-4` — module number and episode key — so
the URL says where you are. Keys repeat across modules, which is why the module
number is in the path.

### Progress is per episode, not per language

`PUT /progress/:episodeId` stores one row per person per episode, carrying the
language they were last watching in. Switching from English to Malayalam keeps
your place, because it is the same episode either way — the payoff of pairing
the two courses rather than shipping them side by side.

Saved at most every 15 seconds while playing, and flushed when the page
unmounts, since leaving mid-episode is the normal case. Completing sets a flag
that a re-watch doesn't clear.

### What signed-out visitors see

The whole contents list, with locked episodes marked. `GET /courses/:slug` is
public for exactly this reason — the list is the strongest argument for the
programme, and hiding it behind a sign-in wall would trade that away. Only the
video URLs are gated.

### Popups

The seminar and free-episode popups are suppressed under `/learn` and for anyone
carrying a session — offering a free taster to someone who already bought the
programme reads as not knowing who they are. That check uses the readable
`da_session` hint cookie rather than a network call, so an anonymous visitor to
the marketing site still pays nothing on page load.

## Phase 5 — signed playback (done)

```bash
bun run check:r2     # proves the signatures are valid, sends no video
```

Every playback URL is now presigned against R2 and expires after
`R2_VIDEO_URL_TTL` (six hours by default — long enough to watch a 25-minute
episode and pause for a coffee, short enough that a shared link dies).

### Matched to the LMS

`~/delta/lms` signs its lesson videos the same way, against the same bucket, so
the two were lined up deliberately rather than left to drift:

- **Key derivation** mirrors its `keyFromUrl`
  (`backend/src/services/r2.service.ts`): parse the pathname, decode it, strip a
  local-disk `uploads/` prefix, and refuse any key containing `..`.
- **Addressing** is virtual-hosted — `lms-delta.<account>.r2.cloudflarestorage.com`
  — which is what its AWS SDK emits. R2 accepts path style too; one form across
  both services is one thing to reason about.
- **Verified against it**, not assumed: the same object was signed through the
  LMS's own `generatePresignedGetUrl` and through this code, and both return
  206 from the same host.

Two deliberate differences:

- **External URLs pass through.** The LMS derives a key from *any* URL, so a
  lesson pointing at an externally-hosted video becomes a bogus key it then
  signs against our bucket. This checks the origin first — the behaviour the
  LMS's own comment describes but its code doesn't implement.
- **`aws4fetch` rather than the AWS SDK.** Signing a GET is the only thing
  needed here, and it costs about ten kilobytes instead of several megabytes.
  The output is the same SigV4 presigned URL; the SDK adds `x-id` and
  `X-Amz-Content-Sha256`, which a presigned GET does not require.

A note on the traversal guard, since it is easy to misread: `new URL()` resolves
a plain `../` away while parsing, so the guard exists for the *encoded* form
(`%2e%2e%2f`), where the `..` only appears after decoding — which is exactly
where the check sits. Both cases are covered in `check:r2`.

### The bucket was already private

The public `pub-….r2.dev` address answers **401**. That is the desired end
state, but it arrived before the code did, which means the free episode on
`/watch` and in the homepage popup had been serving a dead video — those two
places used hardcoded public URLs.

`GET /episodes/free` fixes that: it resolves the free episode and signs it with
no account required. `components/free-episode-player.tsx` fetches it.

There is deliberately **no fallback** to the URLs in `lib/episode.ts`. Handing a
dead URL to the player shows a broken video, which reads as a broken site; the
component says it couldn't load instead.

### Why this doesn't break the LMS

`~/delta/lms` shares this bucket, and its `lessons.routes.ts` already serves
lesson videos through `generatePresignedGetUrl`. Both services sign, so neither
depends on public access.

### CORS

Signed URLs are on the S3 endpoint, which sends no
`Access-Control-Allow-Origin`. That is fine: a `<video>` load is no-cors unless
the element sets `crossorigin`, and ours does not. A page-level `fetch()` of the
video URL *is* blocked — nothing in the app does that.

### What signing does and doesn't buy

It stops the catalogue being permanently public. It does not stop a paying
viewer copying a live URL and sharing it for the length of its TTL. Closing that
needs per-viewer tokenised delivery or DRM, which is a different order of
complexity — worth doing only if link-sharing turns out to be a real problem.

## Requirements

- **Bun** — `mongodb` is pinned to **6.x on purpose**. The 7.x driver ships
  bson 7, whose module initialiser calls `node:v8`'s `isBuildingSnapshot`,
  which Bun 1.3 does not implement; importing it crashes before any code runs.
  The marketing site stays on the 7.x driver, which is fine — it runs on Node.
- **ffprobe** (`brew install ffmpeg`) for the duration backfill.
- `MONGODB_URI` and `MONGODB_DB` — see `.env.example`.

The course exports are never copied into this repo: their `_meta.source` is the
origin cluster's connection string, credentials included.
