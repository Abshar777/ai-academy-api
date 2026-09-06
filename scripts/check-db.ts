/** What's already in the target database, before the import writes anything. */
import { getDb, closeDb } from "../src/db.ts";

const db = await getDb();
const names = (await db.listCollections().toArray()).map((c) => c.name).sort();
console.log("\n  database:", db.databaseName);
console.log("  existing collections:", names.join(", ") || "(none)");
for (const n of ["courses", "modules", "episodes"]) {
  const state = names.includes(n)
    ? `${await db.collection(n).countDocuments()} docs — ALREADY EXISTS`
    : "does not exist yet";
  console.log(`    ${n.padEnd(10)} ${state}`);
}
console.log();
await closeDb();
