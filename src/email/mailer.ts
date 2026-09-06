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

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (transporter) return transporter;
  const smtp = env.smtp();
  if (!smtp) return null;
  transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
  });
  return transporter;
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

/** Never throws: a mail failure must not turn into a 500 that tells the caller
 *  whether the address exists. It's logged and the request still succeeds. */
export async function sendSignInCode(email: string, code: string): Promise<{ sent: boolean }> {
  const transport = getTransporter();
  const smtp = env.smtp();
  if (!transport || !smtp) {
    console.warn("[mailer] SMTP not configured — sign-in code not sent to", email);
    return { sent: false };
  }

  try {
    await transport.sendMail({
      from: smtp.from,
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
    });
    return { sent: true };
  } catch (err) {
    console.error("[mailer] Failed to send sign-in code", err);
    return { sent: false };
  }
}
