import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const builtMigration = fileURLToPath(new URL("../dist/migrations/0000_foundation.sql", import.meta.url));
let pglite: PGlite | undefined;

afterEach(async () => {
  await pglite?.close();
  pglite = undefined;
});

describe("built migration package", () => {
  it("includes the committed migration and can execute it without source migrations", async () => {
    const sql = await readFile(builtMigration, "utf8");
    pglite = await PGlite.create({ extensions: { pgcrypto } });
    await pglite.exec(sql);

    await expect(pglite.query("select to_regclass('public.questions') as table_name"))
      .resolves.toMatchObject({ rows: [{ table_name: "questions" }] });
  });
});
