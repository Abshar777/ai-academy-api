import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../env.ts";

/**
 * Shares the marketing site's SMTP credentials and visual shell, so a sign-in
 * code doesn't arrive looking like it came from somewhere else. Kept as its own
 * copy rather than imported across the repo boundary — the two services deploy
 * separately, and a shared file would couple their release cycles.
 */

const BRAND_LIME = "#d3fb52";
const BRAND_INK = "#171717";

type Mailbox = { name: string; transporter: Transporter; from: string };

let mailboxes: Mailbox[] | null = null;

/** The configured mailboxes in priority order: primary, then the optional
 *  backup. Built once and cached. */
function getMailboxes(): Mailbox[] {
  if (mailboxes) return mailboxes;
  const build = (cfg: NonNullable<ReturnType<typeof env.smtp>>): Transporter =>
    nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.port === 465,
      auth: { user: cfg.user, pass: cfg.pass },
    });
  const boxes: Mailbox[] = [];
  const primary = env.smtp();
  if (primary) boxes.push({ name: "primary", transporter: build(primary), from: primary.from });
  const backup = env.smtpBackup();
  if (backup) boxes.push({ name: "backup", transporter: build(backup), from: backup.from });
  mailboxes = boxes;
  return boxes;
}

type Msg = { to: string; subject: string; html: string; text: string };

/**
 * Sends a message, trying each mailbox (primary then backup) with one quick
 * retry each — so a single account being throttled by the provider doesn't stop
 * the mail. Never throws: the outcome is reported as { sent }, and the caller
 * decides what to tell the recipient (sign-in flows never surface a mail
 * failure as an error).
 */
async function deliver(msg: Msg, label: string): Promise<{ sent: boolean }> {
  const boxes = getMailboxes();
  if (!boxes.length) {
    console.warn(`[mailer] SMTP not configured — ${label} not sent to`, msg.to);
    return { sent: false };
  }
  for (const box of boxes) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await box.transporter.sendMail({ from: box.from, ...msg });
        if (box.name !== "primary" || attempt > 1) {
          console.info(`[mailer] ${label} sent via ${box.name} (attempt ${attempt})`);
        }
        return { sent: true };
      } catch (err) {
        console.error(`[mailer] ${label} via ${box.name} failed (attempt ${attempt}):`, (err as Error)?.message ?? err);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  console.error(`[mailer] ${label} — all mailboxes failed for`, msg.to);
  return { sent: false };
}

function layout(preheader: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
  <body style="margin:0;padding:0;background-color:#f4f4f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <span style="display:none;font-size:1px;color:#f4f4f2;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f2;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:20px;overflow:hidden;">
          <tr><td style="background-color:${BRAND_INK};padding:28px 32px;">
            <span style="display:inline-block;width:10px;height:10px;border-radius:999px;background-color:${BRAND_LIME};margin-right:8px;vertical-align:middle;"></span>
            <span style="color:#ffffff;font-size:16px;font-weight:600;letter-spacing:-0.01em;vertical-align:middle;">Delta AI Academy</span>
          </td></tr>
          <tr><td style="padding:32px;color:#171717;font-size:15px;line-height:1.6;">${bodyHtml}</td></tr>
          <tr><td style="padding:20px 32px;border-top:1px solid #ececec;color:#8a8a8a;font-size:12px;line-height:1.5;">
            Delta AI Academy &mdash; you're receiving this because someone entered this address to sign in.
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

/** One-time sign-in LINK (post-purchase handoff). Same never-throws contract as
 *  the code mail: a failure is logged, never surfaced to the recipient. */
export async function sendLoginLink(email: string, link: string): Promise<{ sent: boolean }> {
  return deliver(
    {
      to: email,
      subject: "Your Delta AI Academy sign-in link",
      html: layout(
        "Your access is ready — tap to sign in to Delta AI Academy.",
        `<h2 style="margin:0 0 4px;font-size:22px;letter-spacing:-0.01em;">You're in 🎉</h2>
         <p style="margin:0 0 24px;color:#444;">Your course access is ready. Tap the button below to sign in — no password needed. This link signs you in once and expires soon.</p>
         <p style="margin:0 0 24px;">
           <a href="${link}" style="display:inline-block;background-color:${BRAND_INK};color:${BRAND_LIME};text-decoration:none;font-weight:600;font-size:15px;padding:14px 26px;border-radius:12px;">Sign in to Delta AI Academy</a>
         </p>
         <p style="margin:0 0 8px;color:#555;">Or paste this link into your browser:</p>
         <p style="margin:0 0 24px;word-break:break-all;font-size:13px;color:#0057b8;">${link}</p>
         <p style="margin:0;color:#555;">Didn't buy anything? You can ignore this email — the link only works for this address.</p>`,
      ),
      text: `Sign in to Delta AI Academy: ${link}`,
    },
    "login link",
  );
}

/** Never throws: a mail failure must not turn into a 500 that tells the caller
 *  whether the address exists. It's logged and the request still succeeds. */
/** Tells the admin a buyer is waiting on a second-device approval, so it doesn't
 *  sit unseen. Best-effort — a mail failure never blocks the sign-in. */
export async function sendDeviceApprovalRequest(
  adminEmail: string,
  buyerEmail: string,
  deviceLabel: string,
  reviewUrl?: string,
): Promise<{ sent: boolean }> {
  const button = reviewUrl
    ? `<p style="margin:0 0 24px;"><a href="${reviewUrl}" style="display:inline-block;background:${BRAND_INK};color:#fff;font-weight:600;padding:12px 24px;border-radius:12px;text-decoration:none;">Review devices</a></p>`
    : "";

  return deliver(
    {
      to: adminEmail,
      subject: "A buyer is waiting for device approval",
      html: layout(
        `${buyerEmail} is trying to sign in on a second device (${deviceLabel}) and needs approval.`,
        `<h2 style="margin:0 0 4px;font-size:22px;letter-spacing:-0.01em;">New device to review</h2>
         <p style="margin:0 0 24px;color:#444;"><strong>${buyerEmail}</strong> is trying to sign in on a second device (${deviceLabel}). Buyers are limited to two devices, so this one needs approval before they can watch on it.</p>
         ${button}
         <p style="margin:0;color:#555;">Don't recognise it? Revoke the device from the same page — its session ends within minutes.</p>`,
      ),
      text: `${buyerEmail} is waiting for approval on a second device (${deviceLabel}).${reviewUrl ? ` Review: ${reviewUrl}` : ""}`,
    },
    "device-approval notice",
  );
}

export async function sendSignInCode(email: string, code: string): Promise<{ sent: boolean }> {
  return deliver(
    {
      to: email,
      subject: `${code} is your Delta AI Academy sign-in code`,
      html: layout(
        `Your sign-in code is ${code}. It expires in 10 minutes.`,
        `<h2 style="margin:0 0 4px;font-size:22px;letter-spacing:-0.01em;">Your sign-in code</h2>
         <p style="margin:0 0 24px;color:#444;">Enter this to finish signing in. It expires in 10 minutes.</p>
         <p style="margin:0 0 24px;font-size:34px;font-weight:700;letter-spacing:0.16em;color:${BRAND_INK};">${code}</p>
         <p style="margin:0;color:#555;">Didn't try to sign in? You can ignore this email — nobody can get in without the code.</p>`,
      ),
      text: `Your Delta AI Academy sign-in code is ${code}. It expires in 10 minutes.`,
    },
    "sign-in code",
  );
}
