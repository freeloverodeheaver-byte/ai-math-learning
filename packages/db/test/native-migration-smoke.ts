import { createDb, migrateDb } from "../src/index.js";

const connectionString = process.env.TEST_DATABASE_URL;

if (!connectionString) {
  throw new Error("TEST_DATABASE_URL is required for the native PostgreSQL migration smoke test");
}

const db = createDb(connectionString);

try {
  await migrateDb(db);
} finally {
  await db.$client.end();
}
