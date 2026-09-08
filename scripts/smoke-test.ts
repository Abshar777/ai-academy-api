/**
 * Exercises the whole API against a running server: sign-in, session rotation,
 * refresh-token reuse detection, the paywall, and rate limiting.
 *
 * Creates users on a .invalid domain and deletes them at the end, so running it
 * against the real database leaves nothing behind.
 *
 *   bun run src/index.ts &        # or: bun run dev
 *   bun run scripts/smoke-test.ts
 */
import { getDb, closeDb } from "../src/db.ts";
import { USERS, SESSIONS, OTPS, ENTITLEMENTS, HANDOFFS } from "../src/auth/types.ts";
import { PROGRESS } from "../src/content/types.ts";
import { hash } from "../src/auth/crypto.ts";

const BASE = process.env.API_URL ?? "http://localhost:6112";
const stamp = Date.now();
const email = `smoke-${stamp}@smoke-test.invalid`;

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  — ${detail}` : ""}`); }
}

type Res = { status: number; body: any; setCookie: string | null; rawCookies: string };

async function call(path: string, init: RequestInit = {}, cookie?: string): Promise<Res> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  if (cookie) headers.set("Cookie", cookie);
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
  const body = await res.json().catch(() => null);
  const raw = res.headers.get("set-cookie") ?? "";
  return { status: res.status, body, setCookie: raw.split(";")[0] ?? null, rawCookies: raw };
}

const post = (p: string, data?: unknown, cookie?: string) =>
  call(p, { method: "POST", body: data ? JSON.stringify(data) : undefined }, cookie);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

console.log(`\n  academy-api smoke test  →  ${BASE}\n`);

// ---------------------------------------------------------------- health
const health = await call("/health");
check("health reports the database reachable", health.status === 200 && health.body?.ok === true,
  JSON.stringify(health.body));

// ------------------------------------------------------------ sign-in flow
console.log("\n  sign-in");
const badEmail = await post("/auth/otp/request", { email: "not-an-email" });
check("rejects a malformed address", badEmail.status === 400);

const requested = await post("/auth/otp/request", { email });
const code = requested.body?.devCode;
check("issues a code", requested.status === 200 && /^\d{6}$/.test(code ?? ""),
  `status ${requested.status}, devCode ${code ?? "missing (set OTP_ECHO=1)"}`);

const wrongCode = await post("/auth/otp/verify", { email, code: code === "000000" ? "111111" : "000000" });
check("rejects the wrong code", wrongCode.status === 400);

const verified = await post("/auth/otp/verify", { email, code });
const accessToken: string = verified.body?.accessToken ?? "";
const cookieA = verified.setCookie;
check("accepts the right code and returns a token", verified.status === 200 && accessToken.length > 20);
check("sets an httpOnly refresh cookie", (cookieA ?? "").startsWith("da_refresh="));
{
  const raw = verified.rawCookies ?? "";
  check("sets the readable session hint the site reads", raw.includes("da_session=1"), raw.slice(0, 80));
}
check("creates the account on first sign-in", verified.body?.user?.email === email);

const replay = await post("/auth/otp/verify", { email, code });
check("a code cannot be used twice", replay.status === 400);

// ------------------------------------------------------------------- /me
console.log("\n  identity");
const meAnon = await call("/me");
check("/me needs a token", meAnon.status === 401);

const me = await call("/me", { headers: auth(accessToken) });
check("/me returns the signed-in user", me.status === 200 && me.body?.user?.email === email);
check("no entitlements yet", Array.isArray(me.body?.courses) && me.body.courses.length === 0);

const badLang = await call("/me", { method: "PATCH", body: JSON.stringify({ preferredLang: "fr" }), headers: auth(accessToken) });
check("rejects an unsupported language", badLang.status === 400);

const setLang = await call("/me", { method: "PATCH", body: JSON.stringify({ preferredLang: "ml" }), headers: auth(accessToken) });
check("stores the preferred language", setLang.status === 200 && setLang.body?.preferredLang === "ml");

// --------------------------------------------------------------- content
console.log("\n  course content");
const course = await call("/courses/ai-academy");
const modules = course.body?.modules ?? [];
const episodes = modules.flatMap((m: any) => m.episodes ?? []);
check("course listing is public", course.status === 200);
check("returns 4 modules", modules.length === 4, `got ${modules.length}`);
check("returns 34 episodes", episodes.length === 34, `got ${episodes.length}`);
check("reports no entitlement for a signed-out visitor", course.body?.entitled === false);

const bilingual = episodes.filter((e: any) => Object.keys(e.languages ?? {}).length === 2);
check("28 episodes carry both languages", bilingual.length === 28, `got ${bilingual.length}`);
check("listing exposes no playback URLs", !JSON.stringify(course.body).includes("r2.dev"));

const missing = await call("/courses/no-such-course");
check("unknown course 404s", missing.status === 404);

// ------------------------------------------------------------- the paywall
console.log("\n  paywall");
const free = episodes.find((e: any) => e.isFree);
const paid = episodes.find((e: any) => !e.isFree);
check("one episode is marked free", !!free, "none found");

const freePlay = await call(`/episodes/${free.id}/play`);
check("free episode plays without an account", freePlay.status === 200 && !!freePlay.body?.sources?.en?.url);

const paidAnon = await call(`/episodes/${paid.id}/play`);
check("paid episode refuses an anonymous viewer", paidAnon.status === 401);

const paidAuthed = await call(`/episodes/${paid.id}/play`, { headers: auth(accessToken) });
check("paid episode refuses a signed-in viewer without an entitlement", paidAuthed.status === 403);

const badId = await call("/episodes/not-an-id/play");
check("a malformed episode id 404s", badId.status === 404);

// -------------------------------------------------------- session rotation
console.log("\n  session rotation");
const refreshed = await post("/auth/refresh", undefined, cookieA!);
const cookieB = refreshed.setCookie;
check("refresh returns a new access token", refreshed.status === 200 && !!refreshed.body?.accessToken);
check("refresh rotates the cookie", !!cookieB && cookieB !== cookieA);

// A token rotated moments ago still answers. Two page loads can each ask for
// a session before either one's cookie lands, and signing someone out for
// navigating quickly is worse than the replay window this leaves open.
const racing = await post("/auth/refresh", undefined, cookieA!);
check("a just-rotated token still works, so a page-load race can't sign you out",
  racing.status === 200, `got ${racing.status}`);

// Replayed long after the fact it is treated as theft. Ageing the revocation
// past the leeway is the only way to test that without waiting it out.
{
  const db = await getDb();
  const rawA = (cookieA ?? "").split("=")[1] ?? "";
  await db.collection(SESSIONS).updateMany(
    { tokenHash: hash(rawA) },
    { $set: { revokedAt: new Date(Date.now() - 5 * 60_000) } },
  );
  const replayed = await post("/auth/refresh", undefined, cookieA!);
  check("an old token replayed later is rejected", replayed.status === 401, `got ${replayed.status}`);

  const afterReuse = await post("/auth/refresh", undefined, racing.setCookie ?? cookieB!);
  check("and that replay revokes the whole session family", afterReuse.status === 401,
    `expected 401, got ${afterReuse.status}`);
}

// -------------------------------------------------------------- rate limit
console.log("\n  rate limiting");
const limited = `limit-${stamp}@smoke-test.invalid`;
const codes = [];
for (let i = 0; i < 4; i++) codes.push((await post("/auth/otp/request", { email: limited })).status);
check("allows 3 code requests then throttles", codes.slice(0, 3).every((s) => s === 200) && codes[3] === 429,
  codes.join(","));

// ------------------------------------------------------------------ logout
console.log("\n  logout");
const relogin = await post("/auth/otp/request", { email });
const second = await post("/auth/otp/verify", { email, code: relogin.body?.devCode });
const loggedOut = await post("/auth/logout", undefined, second.setCookie!);
check("logout succeeds", loggedOut.status === 200);
const afterLogout = await post("/auth/refresh", undefined, second.setCookie!);
check("the revoked cookie no longer refreshes", afterLogout.status === 401);

// --------------------------------------------------- purchase → auto sign-in
console.log("\n  purchase bridge");
const buyer = `buyer-${stamp}@smoke-test.invalid`;
const orderRef = `razorpay:pay_smoke_${stamp}`;
const grantBody = { email: buyer, name: "Smoke Buyer", source: "razorpay", orderRef };
const secret = process.env.INTERNAL_API_SECRET ?? "";

const noSecret = await post("/internal/grant", grantBody);
check("grant refuses a request with no secret", noSecret.status === 401);

const wrongSecret = await call("/internal/grant", {
  method: "POST", body: JSON.stringify(grantBody), headers: { "X-Internal-Secret": "wrong" },
});
check("grant refuses a wrong secret", wrongSecret.status === 401);

const internal = { "X-Internal-Secret": secret };
const grant = await call("/internal/grant", { method: "POST", body: JSON.stringify(grantBody), headers: internal });
check("grant creates the account and access", grant.status === 200 && grant.body?.granted === true,
  JSON.stringify(grant.body));
check("grant returns a handoff ticket", typeof grant.body?.handoffToken === "string");

const regrant = await call("/internal/grant", { method: "POST", body: JSON.stringify(grantBody), headers: internal });
check("the same payment grants only once", regrant.status === 200 && regrant.body?.alreadyGranted === true);
check("a repeat still returns a ticket for the waiting browser", typeof regrant.body?.handoffToken === "string");

const badSource = await call("/internal/grant", {
  method: "POST", headers: internal,
  body: JSON.stringify({ ...grantBody, source: "bitcoin", orderRef: `x-${stamp}` }),
});
check("grant rejects an unknown payment source", badSource.status === 400);

const handoff = await post("/auth/handoff", { token: grant.body.handoffToken });
const buyerToken: string = handoff.body?.accessToken ?? "";
check("the ticket signs the buyer in", handoff.status === 200 && buyerToken.length > 20);
check("the ticket sets a refresh cookie", (handoff.setCookie ?? "").startsWith("da_refresh="));
check("it signs in as the buyer", handoff.body?.user?.email === buyer);

const reusedHandoff = await post("/auth/handoff", { token: grant.body.handoffToken });
check("a ticket cannot be used twice", reusedHandoff.status === 401);

const fakeHandoff = await post("/auth/handoff", { token: "not-a-real-ticket" });
check("a made-up ticket is rejected", fakeHandoff.status === 401);

console.log("\n  access after purchase");
const buyerMe = await call("/me", { headers: auth(buyerToken) });
check("/me now lists the course", buyerMe.status === 200 && buyerMe.body?.courses?.length === 1,
  JSON.stringify(buyerMe.body?.courses));

const buyerCourse = await call("/courses/ai-academy", { headers: auth(buyerToken) });
check("the course reports the buyer as entitled", buyerCourse.body?.entitled === true);

const buyerPlay = await call(`/episodes/${paid.id}/play`, { headers: auth(buyerToken) });
check("the paid episode now plays", buyerPlay.status === 200 && !!buyerPlay.body?.sources);
check("playback returns a signed, expiring URL",
  /X-Amz-Signature=/.test(buyerPlay.body?.sources?.en?.url ?? buyerPlay.body?.sources?.ml?.url ?? ""),
  (buyerPlay.body?.sources?.en?.url ?? "").slice(0, 60));
check("and says how long it lasts", typeof buyerPlay.body?.expiresIn === "number");

const stillBlocked = await call(`/episodes/${paid.id}/play`, { headers: auth(accessToken) });
check("a different account is still blocked", stillBlocked.status === 403);

console.log("\n  progress");
const freeEpisodeId = free.id;

const anonSave = await call(`/progress/${freeEpisodeId}`, {
  method: "PUT", body: JSON.stringify({ positionSec: 30, lang: "en" }),
});
check("saving progress needs a session", anonSave.status === 401);

const badPosition = await call(`/progress/${paid.id}`, {
  method: "PUT", body: JSON.stringify({ positionSec: "halfway", lang: "en" }), headers: auth(buyerToken),
});
check("rejects a non-numeric position", badPosition.status === 400);

const badLangSave = await call(`/progress/${paid.id}`, {
  method: "PUT", body: JSON.stringify({ positionSec: 30, lang: "fr" }), headers: auth(buyerToken),
});
check("rejects an unsupported language", badLangSave.status === 400);

const notEntitledSave = await call(`/progress/${paid.id}`, {
  method: "PUT", body: JSON.stringify({ positionSec: 30, lang: "en" }), headers: auth(accessToken),
});
check("refuses progress on an episode you can't watch", notEntitledSave.status === 403);

const saved = await call(`/progress/${paid.id}`, {
  method: "PUT", body: JSON.stringify({ positionSec: 137, lang: "ml" }), headers: auth(buyerToken),
});
check("the buyer's position saves", saved.status === 200);

const withProgress = await call("/courses/ai-academy", { headers: auth(buyerToken) });
const savedEpisode = withProgress.body?.modules
  ?.flatMap((m: any) => m.episodes)
  ?.find((e: any) => e.id === paid.id);
check("the course reports it back", savedEpisode?.progress?.positionSec === 137,
  JSON.stringify(savedEpisode?.progress));
check("and remembers the language", savedEpisode?.progress?.lastLang === "ml");
check("resume points at that episode", withProgress.body?.resumeEpisodeId === paid.id);

await call(`/progress/${paid.id}`, {
  method: "PUT", body: JSON.stringify({ positionSec: 400, lang: "ml", completed: true }), headers: auth(buyerToken),
});
const afterDone = await call("/courses/ai-academy", { headers: auth(buyerToken) });
const doneEpisode = afterDone.body?.modules?.flatMap((m: any) => m.episodes)?.find((e: any) => e.id === paid.id);
check("completing marks it complete", doneEpisode?.progress?.completed === true);
check("a finished episode drops out of resume", afterDone.body?.resumeEpisodeId === null,
  String(afterDone.body?.resumeEpisodeId));

// Re-watching moves the position back without un-finishing the episode.
await call(`/progress/${paid.id}`, {
  method: "PUT", body: JSON.stringify({ positionSec: 12, lang: "en" }), headers: auth(buyerToken),
});
const rewatch = await call("/courses/ai-academy", { headers: auth(buyerToken) });
const rewatched = rewatch.body?.modules?.flatMap((m: any) => m.episodes)?.find((e: any) => e.id === paid.id);
check("re-watching keeps the completed tick", rewatched?.progress?.completed === true && rewatched?.progress?.positionSec === 12);

console.log("\n  video signing");
const freeRoute = await call("/episodes/free");
const freeUrl = freeRoute.body?.sources?.en?.url ?? "";
check("the free episode resolves without an account", freeRoute.status === 200 && !!freeUrl);
check("its URL is signed too", /X-Amz-Signature=/.test(freeUrl), freeUrl.slice(0, 60));
check("both languages come back at once",
  Object.keys(freeRoute.body?.sources ?? {}).length === 2,
  Object.keys(freeRoute.body?.sources ?? {}).join(","));

// The signature is what gates the file, so it has to actually work — and a URL
// with the signature stripped has to actually fail.
const fetched = await fetch(freeUrl, { headers: { Range: "bytes=0-1023" } });
check("a signed URL plays", fetched.ok || fetched.status === 206, `got ${fetched.status}`);

const stripped = freeUrl.replace(/[?&]X-Amz-Signature=[0-9a-f]+/, "");
const strippedRes = await fetch(stripped, { headers: { Range: "bytes=0-1023" } });
check("the same URL without its signature does not", !strippedRes.ok, `got ${strippedRes.status}`);

// ----------------------------------------------------------------- cleanup
const db = await getDb();
const users = await db.collection(USERS).find({ email: { $regex: /@smoke-test\.invalid$/ } }).toArray();
const ids = users.map((u) => u._id);
await db.collection(SESSIONS).deleteMany({ userId: { $in: ids } });
await db.collection(HANDOFFS).deleteMany({ userId: { $in: ids } });
await db.collection(ENTITLEMENTS).deleteMany({ userId: { $in: ids } });
await db.collection(PROGRESS).deleteMany({ userId: { $in: ids } });
await db.collection(USERS).deleteMany({ email: { $regex: /@smoke-test\.invalid$/ } });
await db.collection(OTPS).deleteMany({ email: { $regex: /@smoke-test\.invalid$/ } });
await closeDb();

console.log(`\n  ${passed} passed, ${failed} failed  (test users removed)\n`);
process.exit(failed ? 1 : 0);
