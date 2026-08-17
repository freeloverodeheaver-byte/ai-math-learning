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

    expect(tags).toContain("0002_access_invariants");
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

    const accessIndexes = await pglite.query<{ indexname: string }>(
      "select indexname from pg_indexes where indexname = 'class_memberships_open_unique'"
    );
    expect(accessIndexes.rows).toEqual([{ indexname: "class_memberships_open_unique" }]);

    const accessChecks = await pglite.query<{ constraint_name: string }>(
      `select constraint_name from information_schema.check_constraints
       where constraint_name in ('class_memberships_state_resolved_check', 'data_sharing_grants_scope_check')
       order by constraint_name`
    );
    expect(accessChecks.rows.map((row) => row.constraint_name)).toEqual([
      "class_memberships_state_resolved_check",
      "data_sharing_grants_scope_check"
    ]);

    const accessTriggers = await pglite.query<{ tgname: string }>(
      `select tgname from pg_trigger
       where not tgisinternal
         and tgname in (
           'data_sharing_grants_active_integrity',
           'class_memberships_active_grants_integrity',
           'classes_active_grants_owner_integrity'
         )
       order by tgname`
    );
    expect(accessTriggers.rows.map((row) => row.tgname)).toEqual([
      "class_memberships_active_grants_integrity",
      "classes_active_grants_owner_integrity",
      "data_sharing_grants_active_integrity"
    ]);
  });
});
