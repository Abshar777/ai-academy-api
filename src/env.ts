/**
 * Environment access, read lazily so importing a module never crashes on a
 * missing variable — only actually using the feature does, with a message that
 * names what to set.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export const env = {
  port: () => Number(process.env.PORT) || 6112,

  /** Signs access tokens, and peppers the OTP and refresh-token hashes. A leak
   *  of the database alone is then not enough to forge either. */
  authSecret: () => required("AUTH_SECRET"),

  /** Shared secret the marketing site presents on /internal/*. Separate from
   *  AUTH_SECRET so it can be rotated without signing every user out. */
  internalSecret: () => required("INTERNAL_API_SECRET"),

  /** LMS purchase-mirror: after a grant, POST the buyer to the LMS so they also
   *  get an LMS account + both-language course access + a login-link email.
   *  Both must be set to enable it; unset → mirroring is skipped silently. */
  lmsPurchaseUrl: () => process.env.LMS_PURCHASE_URL || undefined,
  lmsSecret:      () => process.env.LMS_S2S_SECRET || undefined,

  /** Where to email a "new device to approve" notice, and the admin Devices
   *  page it links to. Both optional — unset → the notification is skipped
   *  silently (the pending device still waits for approval either way). */
  adminNotifyEmail: () => process.env.ADMIN_NOTIFY_EMAIL || undefined,
  adminDevicesUrl:  () => process.env.ADMIN_DEVICES_URL || undefined,

  /** Origins allowed to call this API with credentials. The marketing site in
   *  production, plus whatever the site runs on locally. */
  allowedOrigins: (): string[] =>
    (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),

  /** Set to ".deltaaiacademy.ai" in production so the API subdomain and the
   *  site share the refresh cookie. Unset locally, where the two are different
   *  ports on localhost and a Domain would break the cookie entirely. */
  cookieDomain: () => process.env.COOKIE_DOMAIN || undefined,

  isProduction: () => process.env.NODE_ENV === "production",

  /**
   * Cloudflare R2, holding every course video. Shares the bucket and
   * credentials with the LMS backend, which already serves its lessons through
   * presigned URLs — so making the bucket private breaks neither service.
   */
  r2: () => {
    const {
      R2_ACCOUNT_ID,
      R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY,
      R2_BUCKET_NAME,
      R2_PUBLIC_URL,
    } = process.env;
    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_PUBLIC_URL) return null;
    return {
      accountId: R2_ACCOUNT_ID,
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
      bucket: R2_BUCKET_NAME || "lms-delta",
      publicUrl: R2_PUBLIC_URL.replace(/\/$/, ""),
    };
  },

  /**
   * Cloudflare Stream. Same Cloudflare account as R2, so the account id is
   * shared; the API token is separate because R2's keys are S3 credentials and
   * cannot call Cloudflare's own API.
   *
   * Returns null until it is configured, and every caller falls back to
   * serving the R2 original — so the migration can run file by file rather
   * than as one flip.
   */
  stream: () => {
    const { CF_STREAM_API_TOKEN, CF_STREAM_CUSTOMER_CODE, R2_ACCOUNT_ID } = process.env;
    if (!CF_STREAM_API_TOKEN || !R2_ACCOUNT_ID) return null;
    return {
      accountId: R2_ACCOUNT_ID,
      apiToken: CF_STREAM_API_TOKEN,
      /** The customer-<code> subdomain playback is served from. The migration
       *  script reports it after the first upload. */
      customerCode: CF_STREAM_CUSTOMER_CODE ?? "",
      signingKeyId: process.env.CF_STREAM_SIGNING_KEY_ID ?? "",
      signingKeyPem: process.env.CF_STREAM_SIGNING_KEY_PEM ?? "",
    };
  },

  /**
   * How long a playback URL stays valid.
   *
   * One hour rather than the six it used to be: this is the window in which a
   * copied link is worth anything to whoever it was copied to. It is shorter
   * than plenty of viewing sessions on purpose — the player re-mints a URL
   * before this runs out, and again if playback errors, so a long session
   * costs a background request rather than a broken video.
   */
  videoUrlTtl: () => {
    const value = Number(process.env.R2_VIDEO_URL_TTL);
    return Number.isFinite(value) && value >= 60 && value <= 86_400 ? value : 60 * 60;
  },

  smtp: () => {
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
    return {
      host: SMTP_HOST,
      port: Number(SMTP_PORT) || 587,
      user: SMTP_USER,
      pass: SMTP_PASS,
      from: process.env.SMTP_FROM || SMTP_USER,
    };
  },

  /** Optional second mailbox, tried when the primary fails or is throttled (see
   *  mailer.ts). Same key names as the LMS backend so the two can share config:
   *  SMTP_BACKUP_HOST/PORT/USER/PASS + SMTP_BACKUP_FROM|SMTP_BACKUP_EMAIL_FROM.
   *  Unset → there's just the primary. */
  smtpBackup: () => {
    const { SMTP_BACKUP_HOST, SMTP_BACKUP_PORT, SMTP_BACKUP_USER, SMTP_BACKUP_PASS } = process.env;
    if (!SMTP_BACKUP_HOST || !SMTP_BACKUP_USER || !SMTP_BACKUP_PASS) return null;
    return {
      host: SMTP_BACKUP_HOST,
      port: Number(SMTP_BACKUP_PORT) || 587,
      user: SMTP_BACKUP_USER,
      pass: SMTP_BACKUP_PASS,
      from: process.env.SMTP_BACKUP_FROM || process.env.SMTP_BACKUP_EMAIL_FROM || SMTP_BACKUP_USER,
    };
  },
};
