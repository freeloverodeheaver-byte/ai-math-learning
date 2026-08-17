import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

interface MigrationJournal {
  entries: Array<{ tag: string }>;
}

export async function applyJournaledMigrations(
  pglite: PGlite,
  migrationsDirectory: URL
): Promise<string[]> {
  const journal = JSON.parse(
    await readFile(new URL("meta/_journal.json", migrationsDirectory), "utf8")
  ) as MigrationJournal;

  for (const entry of journal.entries) {
    await pglite.exec(await readFile(new URL(`${entry.tag}.sql`, migrationsDirectory), "utf8"));
  }

  return journal.entries.map((entry) => entry.tag);
}
