/**
 * Proves the SMTP credentials work without sending anything.
 *
 * nodemailer's verify() opens the connection and completes the handshake and
 * login, then hangs up — enough to catch a wrong host, port, or password, which
 * is what actually breaks sign-in, while nobody's inbox receives a test email.
 */
import nodemailer from "nodemailer";
import { env } from "../src/env.ts";

const smtp = env.smtp();
if (!smtp) {
  console.error("\n  SMTP_HOST / SMTP_USER / SMTP_PASS are not set in this environment.\n");
  process.exit(1);
}

console.log(`\n  host ${smtp.host}:${smtp.port}   user ${smtp.user}   from ${smtp.from}`);

const transport = nodemailer.createTransport({
  host: smtp.host,
  port: smtp.port,
  secure: smtp.port === 465,
  auth: { user: smtp.user, pass: smtp.pass },
});

try {
  await transport.verify();
  console.log("  \x1b[32m✓\x1b[0m handshake and login succeeded — sign-in codes will send\n");
  process.exit(0);
} catch (err) {
  console.error("  \x1b[31m✗\x1b[0m", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
}
