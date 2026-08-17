import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { applyJournaledMigrations } from "./migration-test-utils.js";

let pglite: PGlite | undefined;

afterEach(async () => {
  await pglite?.close();
  pglite = undefined;
});

describe("built migration package", () => {
  it("executes every built journaled migration without source migrations", async () => {
    pglite = await PGlite.create({ extensions: { pgcrypto } });
    const tags = await applyJournaledMigrations(pglite, new URL("../dist/migrations/", import.meta.url));

    expect(tags.length).toBeGreaterThan(1);
    await expect(pglite.query(
      "select to_regclass('public.questions') as questions, to_regclass('public.content_bundles') as bundles, to_regclass('public.content_entity_owners') as owners, to_regclass('public.source_merge_provenance') as provenance"
    )).resolves.toMatchObject({
      rows: [{
        questions: "questions",
        bundles: "content_bundles",
        owners: "content_entity_owners",
        provenance: "source_merge_provenance"
      }]
    });

    const indexes = await pglite.query<{ indexname: string }>(
      "select indexname from pg_indexes where indexname in ('sources_label_unique', 'content_bundle_versions_bundle_version_unique') order by indexname"
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "content_bundle_versions_bundle_version_unique",
      "sources_label_unique"
    ]);

    const checks = await pglite.query<{ constraint_name: string }>(
      "select constraint_name from information_schema.check_constraints where constraint_name in ('content_bundle_versions_version_check', 'content_entity_owners_type_check') order by constraint_name"
    );
    expect(checks.rows.map((row) => row.constraint_name)).toEqual([
      "content_bundle_versions_version_check",
      "content_entity_owners_type_check"
    ]);
  });
});
