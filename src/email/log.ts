import { getDb } from "../db.ts";

/**
 * This service's half of the email log.
 *
 * The marketing site owns the same collection (ai-academy-v2/lib/email-log.ts)
 * and the admin screen that reads it; this writes rows in the same shape so
 * the sign-in codes and device notices sent from here show up beside the
 * invoices and welcome mail sent from there. "I never got the code" is almost
 * always about one of these three, so a log without them would answer the
 * wrong half of the question.
 *
 * Deliberately a second small copy rather than a shared import: the two
 * services deploy separately, and a shared module would couple their releases
 * for the sake of forty lines.
 */

const EMAIL_LOG = "email_log";

export type EmailKind = "sign-in-code" | "login-link" | "device-approval";
export type EmailStatus = "sent" | "failed" | "skipped";

export type EmailLogRow = {
  kind: EmailKind;
  to: string;
  subject: string;
  status: EmailStatus;
  error?: string;
  mailbox?: string;
  bodyHtml?: string;
  service: "api";
  createdAt: Date;
};

/**
 * Never throws. This runs inside the send path, and a sign-in that failed
 * because the *log* was unreachable would be a bug of our own making — the
 * mailer's whole contract is that it never surfaces a failure to the caller.
 */
export async function logEmail(row: Omit<EmailLogRow, "service" | "createdAt">): Promise<void> {
  try {
    const db = await getDb();
    await db.collection<EmailLogRow>(EMAIL_LOG).insertOne({
      ...row,
      service: "api",
      createdAt: new Date(),
    });
  } catch (err) {
    console.error("[email-log] could not record", row.kind, "to", row.to, (err as Error)?.message ?? err);
  }
}
