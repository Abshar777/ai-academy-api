import { MongoClient, type Db } from "mongodb";

/**
 * Connection for the course API and its scripts. Unlike the marketing site's
 * equivalent (lib/mongodb.ts over there), this one throws when MONGODB_URI is
 * missing: the site degrades gracefully without a database because checkout has
 * to keep working regardless, whereas this service is nothing but database.
 */
let client: MongoClient | null = null;

export async function getDb(): Promise<Db> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
  }
  return client.db(process.env.MONGODB_DB || undefined);
}

export async function closeDb(): Promise<void> {
  await client?.close();
  client = null;
}
