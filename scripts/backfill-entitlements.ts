/**
 * Grants course access to everyone who bought before the purchase bridge
 * existed.
 *
 * Reads the marketing site's `enrollments` ledger — the same database this API
 * writes to — and produces the account and entitlement each row should have
 * had. The reference it keys on is built exactly as the live payment paths
 * build theirs, so a row this script grants and a webhook that later replays
 * the same payment collapse onto one entitlement rather than two.
 *
 *   bun run scripts/backfill-entitlements.ts           # dry run
 *   bun run scripts/backfill-entitlements.ts --write
 */
import { getDb, closeDb } from "../src/db.ts";
import { COURSES, type Course } from "../src/content/types.ts";
import { grantAccess } from "../src/auth/access.ts";
import { upsertUserByEmail } from "../src/auth/users.ts";
import { looksLikeEmail, normalizeEmail } from "../src/auth/crypto.ts";
import type { Entitlement } from "../src/auth/types.ts";

const COURSE_SLUG = "ai-academy";
const WRITE = Bun.argv.includes("--write");

type Enrollment = {
  name?: string;
  email?: string;
  phone?: string;
  country?: string;
  source?: string;
  couponCode?: string;
  razorpayPaymentId?: string;
  abzerOrderId?: string;
  createdAt?: Date;
};

/** Must match the orderRef each live payment path builds, or a replayed
 *  webhook would grant a second entitlement for the same payment. */
function orderRefFor(row: Enrollment, email: string): string | null {
  if (row.source === "razorpay" && row.razorpayPaymentId) return `razorpay:${row.razorpayPaymentId}`;
  if (row.source === "abzer" && row.abzerOrderId) return `abzer:${row.abzerOrderId}`;
  if (row.source === "coupon" && row.couponCode) return `coupon:${row.couponCode}:${email}`;
  return null;
}

const db = await getDb();
const course = await db.collection<Course>(COURSES).findOne({ slug: COURSE_SLUG });
if (!course?._id) throw new Error(`No course "${COURSE_SLUG}" — run the content import first`);

const rows = await db.collection<Enrollment>("enrollments").find({}).sort({ createdAt: 1 }).toArray();
console.log(`\n  ${rows.length} enrollment rows in the ledger\n`);
console.log("  " + "EMAIL".padEnd(34) + "SOURCE".padEnd(10) + "ORDER REF");
console.log("  " + "".padEnd(88, "─"));

let granted = 0;
let already = 0;
const skipped: string[] = [];

for (const row of rows) {
  const email = normalizeEmail(String(row.email ?? ""));
  if (!looksLikeEmail(email)) {
    skipped.push(`row with no usable email (source ${row.source ?? "?"})`);
    continue;
  }
  const orderRef = orderRefFor(row, email);
  if (!orderRef) {
    skipped.push(`${email} — ${row.source ?? "unknown"} row carries no payment reference to key on`);
    continue;
  }

  console.log(`  ${email.slice(0, 32).padEnd(34)}${(row.source ?? "?").padEnd(10)}${orderRef}`);

  if (!WRITE) continue;

  const user = await upsertUserByEmail(email, {
    name: row.name,
    phone: row.phone,
    country: row.country,
  });
  const result = await grantAccess({
    userId: user._id,
    courseId: course._id,
    source: (row.source ?? "manual") as Entitlement["source"],
    orderRef,
  });
  if (result.created) granted++;
  else already++;
}

console.log(`\n  ${"".padEnd(88, "═")}`);
if (skipped.length) {
  console.log(`  SKIPPED (${skipped.length})`);
  for (const note of skipped) console.log(`    · ${note}`);
  console.log();
}
console.log(
  WRITE
    ? `  ${granted} newly granted · ${already} already had access · ${skipped.length} skipped\n`
    : `  Dry run — nothing written. Re-run with --write to grant.\n`,
);
await closeDb();
