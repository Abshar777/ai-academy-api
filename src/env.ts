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

  /** How long a playback URL stays valid. Long enough to watch a 25-minute
   *  episode and pause for a coffee; short enough that a shared link dies. */
  videoUrlTtl: () => {
    const value = Number(process.env.R2_VIDEO_URL_TTL);
    return Number.isFinite(value) && value >= 60 && value <= 86_400 ? value : 6 * 60 * 60;
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
};
