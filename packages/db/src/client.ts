import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.js";

export type Database = NodePgDatabase<typeof schema> & { $client: Pool };

export function createDb(connectionString: string): Database {
  return drizzle(new Pool({ connectionString }), { schema }) as Database;
}
