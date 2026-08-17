import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import type { Database } from "./client.js";
import { createDb } from "./client.js";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

export async function migrateDb(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder });
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required to run migrations");
  await migrateDb(createDb(connectionString));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
