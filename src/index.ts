import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./env.ts";
import { getDb } from "./db.ts";
import { ensureIndexes } from "./indexes.ts";
import { authRoutes } from "./http/auth.ts";
import { courseRoutes } from "./http/courses.ts";
import { internalRoutes } from "./http/internal.ts";
import { meRoutes } from "./http/me.ts";
import { progressRoutes } from "./http/progress.ts";

const app = new Hono();

/**
 * Credentialed CORS, so the refresh cookie travels. That rules out the "*"
 * origin — the browser refuses to send credentials to a wildcard — so the site
 * origins are listed explicitly in ALLOWED_ORIGINS.
 */
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (env.allowedOrigins().includes(origin)) return origin;
      // The site's dev server takes whatever port is free, so pinning it in
      // ALLOWED_ORIGINS would break each time that changed. Development only —
      // in production the explicit list is the whole of it.
      if (!env.isProduction() && /^http:\/\/localhost(:\d+)?$/.test(origin)) return origin;
      return null;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PATCH", "PUT", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

/** Reports whether the database is actually reachable, not just that the
 *  process is up — a health check that only proves the latter will happily
 *  report green while every request 500s. */
app.get("/health", async (c) => {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    return c.json({ ok: true, database: db.databaseName });
  } catch (err) {
    console.error("[health] database unreachable", err);
    return c.json({ ok: false, error: "database unreachable" }, 503);
  }
});

app.route("/auth", authRoutes);
app.route("/internal", internalRoutes);
app.route("/", meRoutes);
app.route("/", courseRoutes);
app.route("/", progressRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  // Logged in full, returned as a generic message: internal errors sometimes
  // carry connection strings and query fragments.
  console.error("[api]", c.req.method, c.req.path, err);
  return c.json({ error: "Something went wrong" }, 500);
});

await ensureIndexes().catch((err) => {
  console.error("[boot] Failed to create indexes", err);
  // Fatal on purpose. Two of these indexes are what make granting access
  // idempotent and sign-in single-account; running without them would look
  // fine and quietly corrupt data.
  process.exit(1);
});

console.log(`  academy-api listening on :${env.port()}`);
console.log(`  allowed origins: ${env.allowedOrigins().join(", ")}`);

export default { port: env.port(), fetch: app.fetch };
