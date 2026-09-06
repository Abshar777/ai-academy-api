import type { Context, Next } from "hono";
import { ObjectId } from "mongodb";
import { getDb } from "../db.ts";
import { readAccessToken } from "./tokens.ts";
import { USERS, type User } from "./types.ts";

export type Vars = { user: User };

/** Reads the bearer token and loads the user, or 401s. Access tokens carry the
 *  id only — the user is fetched so a deleted account can't keep using a token
 *  that hasn't expired yet. */
export async function requireAuth(c: Context<{ Variables: Vars }>, next: Next) {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return c.json({ error: "Sign in to continue" }, 401);

  const payload = await readAccessToken(token);
  if (!payload) return c.json({ error: "Your session expired — sign in again" }, 401);

  const db = await getDb();
  const user = await db.collection<User>(USERS).findOne({ _id: new ObjectId(payload.sub) });
  if (!user) return c.json({ error: "Your session expired — sign in again" }, 401);

  c.set("user", user);
  await next();
}

/** Same, but lets the request through unauthenticated — used where the response
 *  is richer for a signed-in caller but still valid without one. */
export async function optionalAuth(c: Context<{ Variables: Partial<Vars> }>, next: Next) {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    const payload = await readAccessToken(token);
    if (payload) {
      const db = await getDb();
      const user = await db.collection<User>(USERS).findOne({ _id: new ObjectId(payload.sub) });
      if (user) c.set("user", user);
    }
  }
  await next();
}
