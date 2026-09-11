/**
 * Does signing in stick, or does the site keep asking?
 *
 * Everything here runs at the HTTP level against a real cookie jar, because
 * that is what "am I still signed in" actually is: the browser presents its
 * refresh cookie on a new page load and either gets a session back or does
 * not. The sign-in form appearing is only that answer rendered.
 *
 *   bun run scripts/session-persistence-test.ts
 */
import { getDb, closeDb } from "../src/db.ts";
import { SESSIONS, USERS, ENTITLEMENTS, HANDOFFS, OTPS } from "../src/auth/types.ts";
import { hash } from "../src/auth/crypto.ts";

const API = process.env.API_URL ?? "http://localhost:6112";
const SECRET = process.env.INTERNAL_API_SECRET ?? "";
const email = `persist-${Date.now()}@smoke-test.invalid`;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  — ${detail}` : ""}`); }
}

/** Stands in for one browser: cookies persist across requests, as they would
 *  across page loads. A second jar is a different browser entirely. */
class Jar {
  cookies = new Map<string, string>();

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  absorb(res: Response) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const [k, v] = (pair ?? "").split("=");
      if (!k) continue;
      if (v === "" || /Max-Age=0/i.test(raw)) this.cookies.delete(k);
      else this.cookies.set(k, v ?? "");
    }
  }
  has(name: string) { return this.cookies.has(name); }
  get(name: string) { return this.cookies.get(name); }

  /** A second tab shares the whole jar, not one cookie out of it — the session
   *  is da_refresh plus the da_device cookie the two-device whitelist adds, and
   *  carrying only the first is not a browser, it is a broken one. */
  clone(): Jar {
    const copy = new Jar();
    for (const [k, v] of this.cookies) copy.cookies.set(k, v);
    return copy;
  }

  async fetch(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("Content-Type", "application/json");
    const cookie = this.header();
    if (cookie) headers.set("Cookie", cookie);
    const res = await fetch(`${API}${path}`, { ...init, headers });
    this.absorb(res);
    return res;
  }
}

const post = (jar: Jar, path: string, body?: unknown) =>
  jar.fetch(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });

console.log(`\n  session persistence  →  ${API}\n`);

const browser = new Jar();

// ---------------------------------------------------------------- 1 & 2
console.log("  before signing in");
const anon = await post(browser, "/auth/refresh");
check("1. a visitor with no session is asked to sign in", anon.status === 401, `got ${anon.status}`);

const noEntitlement = await post(browser, "/auth/otp/request", { email });
const noEntCode = ((await noEntitlement.json()) as { devCode?: string }).devCode;
const refused = await post(browser, "/auth/otp/verify", { email, code: noEntCode });
check("2. an address with no purchase behind it cannot sign in", refused.status !== 200,
  `got ${refused.status}`);

// ------------------------------------------------------------------- 3
console.log("\n  signing in");
const granted = await fetch(`${API}/internal/grant`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Internal-Secret": SECRET },
  body: JSON.stringify({
    email, name: "Persist Test", phone: "9876500033", country: "IN",
    source: "razorpay", orderRef: `razorpay:pay_persist_${Date.now()}`,
  }),
});
check("3. the purchase creates the account and its access", granted.status === 200);

const req = await post(browser, "/auth/otp/request", { email });
const code = ((await req.json()) as { devCode?: string }).devCode;
const verified = await post(browser, "/auth/otp/verify", { email, code });
check("   signing in succeeds", verified.status === 200, `got ${verified.status}`);
check("   the browser is holding a session cookie", browser.has("da_refresh"));
check("   and the hint the site reads to skip a lookup", browser.get("da_session") === "1");

// ------------------------------------------------------------------- 4-6
console.log("\n  staying signed in");
const again = await post(browser, "/auth/refresh");
check("4. the very next page load is not asked to sign in again", again.status === 200,
  `got ${again.status}`);

// Two page loads whose refreshes overlap — this is what used to sign people out.
const [raceA, raceB] = await Promise.all([
  post(browser, "/auth/refresh").then((r) => r.status),
  post(browser, "/auth/refresh").then((r) => r.status),
]);
check("5. two page loads racing each other both keep the session",
  raceA === 200 && raceB === 200, `${raceA}, ${raceB}`);

const walk: number[] = [];
for (let i = 0; i < 10; i++) walk.push((await post(browser, "/auth/refresh")).status);
check("6. ten pages in a row, never asked again", walk.every((s) => s === 200), walk.join(","));

// ------------------------------------------------------------------- 7-8
console.log("\n  the awkward cases");
const stale = await browser.fetch("/me", { headers: { Authorization: "Bearer not-a-real-token" } });
check("7. an expired access token is rejected, so the client knows to refresh",
  stale.status === 401, `got ${stale.status}`);
const recovered = await post(browser, "/auth/refresh");
const meAfter = await browser.fetch("/me", {
  headers: { Authorization: `Bearer ${((await recovered.json()) as { accessToken?: string }).accessToken}` },
});
check("   and refreshing puts it right without a new sign-in", meAfter.status === 200);

// A second tab shares the browser's cookies; a different browser does not.
const secondTab = browser.clone();
const tabTwo = await post(secondTab, "/auth/refresh");
check("8. a second tab is signed in already", tabTwo.status === 200, `got ${tabTwo.status}`);

const otherBrowser = new Jar();
const stranger = await post(otherBrowser, "/auth/refresh");
check("   a different browser is not", stranger.status === 401, `got ${stranger.status}`);

// ------------------------------------------------------------------ 9-10
console.log("\n  straight after a purchase");
const buyer = `buyer-${Date.now()}@smoke-test.invalid`;
const grantRes = await fetch(`${API}/internal/grant`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Internal-Secret": SECRET },
  body: JSON.stringify({
    email: buyer, name: "Fresh Buyer", phone: "9876500044", country: "IN",
    source: "razorpay", orderRef: `razorpay:pay_fresh_${Date.now()}`,
  }),
});
const ticket = ((await grantRes.json()) as { handoffToken?: string }).handoffToken;
check("9. the purchase hands back a sign-in ticket", typeof ticket === "string" && ticket.length > 10);

const buyerBrowser = new Jar();
const redeemed = await post(buyerBrowser, "/auth/handoff", { token: ticket });
check("   the buyer lands signed in without touching an email code", redeemed.status === 200);
check("   and their browser is holding a session", buyerBrowser.has("da_refresh"));

const replay = await post(new Jar(), "/auth/handoff", { token: ticket });
check("10. the ticket cannot be spent twice", replay.status === 401, `got ${replay.status}`);
const buyerStillIn = await post(buyerBrowser, "/auth/refresh");
check("    and the buyer's own session is untouched by that", buyerStillIn.status === 200);

// ----------------------------------------------------------------- 11-12
console.log("\n  signing out, and theft");
await post(browser, "/auth/logout");
const afterLogout = await post(browser, "/auth/refresh");
check("11. signing out does ask again, which is the point", afterLogout.status === 401,
  `got ${afterLogout.status}`);

// A token replayed long after it was rotated is theft, not a race.
const db = await getDb();
const live = buyerBrowser.get("da_refresh") ?? "";
const rotated = await post(buyerBrowser, "/auth/refresh");
check("12. rotation issues a new token", rotated.status === 200);
await db.collection(SESSIONS).updateMany(
  { tokenHash: hash(live) },
  { $set: { revokedAt: new Date(Date.now() - 10 * 60_000) } },
);
// A thief holds a copy of everything the browser had, then the token rotates
// underneath them — which is exactly the situation reuse detection is for.
const thief = buyerBrowser.clone();
thief.cookies.set("da_refresh", live);
const stolen = await post(thief, "/auth/refresh");
check("    an old token replayed later is still refused", stolen.status === 401, `got ${stolen.status}`);
const victim = await post(buyerBrowser, "/auth/refresh");
check("    and that replay kills the chain, as it should", victim.status === 401, `got ${victim.status}`);

// ---------------------------------------------------------------- cleanup
const users = await db.collection(USERS).find({ email: { $regex: /@smoke-test\.invalid$/ } }).toArray();
const ids = users.map((u) => u._id);
for (const c of [SESSIONS, HANDOFFS, ENTITLEMENTS]) await db.collection(c).deleteMany({ userId: { $in: ids } });
await db.collection(OTPS).deleteMany({ email: { $regex: /@smoke-test\.invalid$/ } });
await db.collection(USERS).deleteMany({ email: { $regex: /@smoke-test\.invalid$/ } });
await closeDb();

console.log(`\n  ${passed} passed, ${failed} failed  (test users removed)\n`);
process.exit(failed ? 1 : 0);
