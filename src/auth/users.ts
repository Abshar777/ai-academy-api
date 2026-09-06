import type { ObjectId } from "mongodb";
import { getDb } from "../db.ts";
import { USERS, type User } from "./types.ts";

/** A user that has been through the database, so its id is not optional —
 *  saves every caller a non-null assertion. */
export type PersistedUser = User & { _id: ObjectId };

/**
 * Finds or creates the account for an email address.
 *
 * `$setOnInsert` for everything but `lastLoginAt`, so a purchase made under a
 * name that differs from the one already on the account doesn't quietly
 * overwrite it — and so two requests racing here settle on one row rather than
 * one clobbering the other. The unique index on `email` is the backstop.
 */
export async function upsertUserByEmail(
  email: string,
  details: { name?: string; phone?: string; country?: string } = {},
  options: { touchLogin?: boolean } = {},
): Promise<PersistedUser> {
  const db = await getDb();
  const now = new Date();

  const insert: Partial<User> = { email, preferredLang: "en", createdAt: now };
  if (details.name) insert.name = details.name;
  if (details.phone) insert.phone = details.phone;
  if (details.country) insert.country = details.country;

  const user = await db.collection<User>(USERS).findOneAndUpdate(
    { email },
    {
      ...(options.touchLogin ? { $set: { lastLoginAt: now } } : {}),
      $setOnInsert: insert,
    },
    { upsert: true, returnDocument: "after" },
  );

  if (!user?._id) throw new Error(`Failed to upsert user ${email}`);
  return user as PersistedUser;
}
