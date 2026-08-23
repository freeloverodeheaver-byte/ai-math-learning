import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { applyJournaledMigrations } from "./migration-test-utils.js";

let pglite: PGlite | undefined;

async function createBuiltGrantFixture(): Promise<{ grantId: string }> {
  pglite = await PGlite.create({ extensions: { pgcrypto } });
  await applyJournaledMigrations(pglite, new URL("../dist/migrations/", import.meta.url));
  const studentUserId = randomUUID();
  const teacherUserId = randomUUID();
  const studentProfileId = randomUUID();
  const teacherProfileId = randomUUID();
  const classId = randomUUID();
  const membershipId = randomUUID();
  const grantId = randomUUID();
  await pglite.query(
    "insert into users (id, external_subject) values ($1, $2), ($3, $4)",
    [studentUserId, `built-student-${studentUserId}`, teacherUserId, `built-teacher-${teacherUserId}`],
  );
  await pglite.query(
    "insert into student_profiles (id, user_id, display_name, grade, semester) values ($1, $2, 'Built student', 7, 1)",
    [studentProfileId, studentUserId],
  );
  await pglite.query(
    "insert into teacher_profiles (id, user_id, display_name) values ($1, $2, 'Built teacher')",
    [teacherProfileId, teacherUserId],
  );
  await pglite.query(
    "insert into classes (id, teacher_profile_id, name, subject, invite_code) values ($1, $2, 'Built class', 'math', $3)",
    [classId, teacherProfileId, `built-invite-${classId}`],
  );
  await pglite.query(
    "insert into class_memberships (id, class_id, student_profile_id, state, resolved_at) values ($1, $2, $3, 'active', now())",
    [membershipId, classId, studentProfileId],
  );
  await pglite.query(
    "insert into data_sharing_grants (id, class_membership_id, student_profile_id, scope) values ($1, $2, $3, 'learning_summary')",
    [grantId, membershipId, studentProfileId],
  );
  return { grantId };
}

afterEach(async () => {
  await pglite?.close();
  pglite = undefined;
});

describe("built migration package", () => {
  it("packages the audit append-only trigger in the built journal", async () => {
    pglite = await PGlite.create({ extensions: { pgcrypto } });
    await applyJournaledMigrations(pglite, new URL("../dist/migrations/", import.meta.url));
    const subjectId = randomUUID();
    const inserted = await pglite.query<{ id: string }>(
      `insert into audit_events (action, subject_type, subject_id, metadata)
       values ('audit.append-only.built', 'audit_probe', $1, '{}') returning id`,
      [subjectId],
    );
    const eventId = inserted.rows[0]!.id;

    await expect(pglite.query(
      "update audit_events set metadata = '{\"mutated\":true}' where id = $1",
      [eventId],
    )).rejects.toThrow(/append-only/i);
    await expect(pglite.query("delete from audit_events where id = $1", [eventId]))
      .rejects.toThrow(/append-only/i);
  });

  it("executes every built journaled migration without source migrations", async () => {
    pglite = await PGlite.create({ extensions: { pgcrypto } });
    const tags = await applyJournaledMigrations(pglite, new URL("../dist/migrations/", import.meta.url));

    expect(tags).toContain("0002_access_invariants");
    expect(tags).toContain("0003_grant_identity_invariants");
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

  it("uses the built journal to keep grant revocation irreversible", async () => {
    const { grantId } = await createBuiltGrantFixture();

    await expect(pglite!.transaction(async (tx) => {
      await tx.query("update data_sharing_grants set revoked_at = now() where id = $1", [grantId]);
      await tx.query("update data_sharing_grants set revoked_at = null where id = $1", [grantId]);
    })).rejects.toThrow(/revocation/i);
  });

  it("uses the built journal to keep an unrevoked grant's approved scope immutable", async () => {
    const { grantId } = await createBuiltGrantFixture();

    await expect(pglite!.transaction(async (tx) => {
      await tx.query(
        "update data_sharing_grants set scope = 'shared_personal_content' where id = $1",
        [grantId],
      );
    })).rejects.toThrow(/approved identity/i);
  });
});
