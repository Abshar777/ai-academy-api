import { Hono } from "hono";
import { isR2Configured, signGetUrl } from "../media/r2.ts";

export const mediaRoutes = new Hono();

/**
 * Public read for blog images.
 *
 * The bucket's own public hostname answers 401 — public access is off, which is
 * right, because the course videos share this bucket and are the reason it is
 * private. Blog images still have to be readable by anyone with the link: they
 * are pictures in public articles, and a presigned URL baked into a page would
 * expire while the page was still being read, or cached and shared after it had.
 *
 * So this serves them, and only them. The prefix is fixed here rather than taken
 * from the caller, and the name has to be a plain filename — no slashes, no
 * dots leading anywhere — so this cannot be walked sideways into `courses/` and
 * turned into an open video tap.
 *
 * Signing happens server-side with a short life, because the signed URL never
 * leaves this process: it is fetched here and the bytes are streamed on.
 */

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,120})\.(?:jpg|jpeg|png|webp|gif|avif)$/;

mediaRoutes.get("/media/blog/:name", async (c) => {
  if (!isR2Configured()) return c.json({ error: "Not found" }, 404);

  const name = c.req.param("name");
  if (!NAME.test(name) || name.includes("..")) return c.json({ error: "Not found" }, 404);

  try {
    const upstream = await fetch(await signGetUrl(`blog/${name}`, 60));
    if (!upstream.ok || !upstream.body) return c.json({ error: "Not found" }, 404);

    return new Response(upstream.body, {
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
        // The name carries a uuid, so a given URL is the same bytes forever.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    console.error("[media] could not serve blog image", err);
    return c.json({ error: "Not found" }, 404);
  }
});
