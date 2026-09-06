/**
 * send-login-link.ts — mint a one-time sign-in link for an email and email it.
 *
 *   bun scripts/send-login-link.ts <email> [more emails...]
 *
 * The link points at PUBLIC_SITE_URL (fallback: first ALLOWED_ORIGINS, then
 * http://localhost:5173) + /auth/continue?token=... — the page the website
 * exposes to redeem a handoff. Requires SMTP to actually deliver; without it
 * the token is still minted and the link printed so you can use it manually.
 *
 * Upserts the user if they don't exist yet (holding an account is free; access
 * to the video is what a purchase/grant unlocks separately).
 */
import { upsertUserByEmail } from "../src/auth/users.ts";
import { createHandoff } from "../src/auth/handoff.ts";
import { sendLoginLink } from "../src/email/mailer.ts";
import { env } from "../src/env.ts";

const SITE = (process.env.PUBLIC_SITE_URL || env.allowedOrigins()[0] || "http://localhost:5173").replace(/\/+$/, "");

const emails = process.argv.slice(2).filter((a) => a && !a.startsWith("-"));
if (emails.length === 0) {
  console.error("usage: bun scripts/send-login-link.ts <email> [email...]");
  process.exit(1);
}

console.log(`Link base: ${SITE}/auth/continue\n`);

for (const email of emails) {
  try {
    const user = await upsertUserByEmail(email, {});
    const token = await createHandoff(user._id!);
    const link = `${SITE}/auth/continue?token=${token}`;
    const { sent } = await sendLoginLink(email, link);
    console.log(`${email}`);
    console.log(`  ${sent ? "✅ EMAIL SENT" : "⚠️  NOT EMAILED (SMTP not configured)"}`);
    console.log(`  link: ${link}\n`);
  } catch (err) {
    console.error(`${email}  ✗ failed:`, err instanceof Error ? err.message : err);
  }
}

process.exit(0);
