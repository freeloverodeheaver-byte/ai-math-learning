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

async function createBuiltRelationshipSnapshotFixture(): Promise<{
  firstPointId: string;
  secondPointId: string;
  ownerPointId: string;
  questionId: string;
  publishedKnowledgeVersionId: string;
  publishedQuestionVersionId: string;
}> {
  pglite = await PGlite.create({ extensions: { pgcrypto } });
  await applyJournaledMigrations(pglite, new URL("../dist/migrations/", import.meta.url));
  const bundleId = `built-relationships-${randomUUID()}`;
  const firstPointId = randomUUID();
  const secondPointId = randomUUID();
  const ownerPointId = randomUUID();
  const questionId = randomUUID();
  const sourceId = randomUUID();
  const publishedKnowledgeVersionId = randomUUID();
  const publishedQuestionVersionId = randomUUID();

  await pglite.transaction(async (tx) => {
    await tx.query("insert into content_bundles (bundle_id) values ($1)", [bundleId]);
    await tx.query(
      `insert into content_entity_owners (entity_type, entity_key, bundle_id) values
        ('knowledge', $1, $4), ('knowledge', $2, $4), ('knowledge', $3, $4), ('question', $5, $4)`,
      [
        `built-relationship-first-${firstPointId}`,
        `built-relationship-second-${secondPointId}`,
        `built-relationship-owner-${ownerPointId}`,
        bundleId,
        `built-relationship-question-${questionId}`,
      ],
    );
    await tx.query(
      `insert into knowledge_points (id, canonical_id, name, grade, semester) values
        ($1, $4, 'First point', 7, 1),
        ($2, $5, 'Second point', 7, 1),
        ($3, $6, 'Owner point', 7, 1)`,
      [
        firstPointId,
        secondPointId,
        ownerPointId,
        `built-relationship-first-${firstPointId}`,
        `built-relationship-second-${secondPointId}`,
        `built-relationship-owner-${ownerPointId}`,
      ],
    );
    await tx.query("insert into questions (id, external_key) values ($1, $2)", [
      questionId,
      `built-relationship-question-${questionId}`,
    ]);
    await tx.query("insert into sources (id, label) values ($1, $2)", [sourceId, `Built source ${sourceId}`]);
    await tx.query(
      `insert into knowledge_point_versions
        (id, knowledge_point_id, version, name, grade, semester, review_state)
       values ($1, $2, 1, 'Published owner point', 7, 1, 'draft')`,
      [publishedKnowledgeVersionId, ownerPointId],
    );
    await tx.query(
      "insert into knowledge_point_version_prerequisites (knowledge_point_version_id, prerequisite_knowledge_point_id) values ($1, $2)",
      [publishedKnowledgeVersionId, firstPointId],
    );
    await tx.query("update knowledge_point_versions set review_state = 'published' where id = $1", [publishedKnowledgeVersionId]);
    await tx.query("insert into question_knowledge_points (question_id, knowledge_point_id) values ($1, $2)", [
      questionId,
      firstPointId,
    ]);
    await tx.query(
      `insert into question_versions
        (id, question_id, version, stem, answer, explanation, source_id, review_state)
       values ($1, $2, 1, 'Built snapshot question', 'Answer', 'Explanation', $3, 'draft')`,
      [publishedQuestionVersionId, questionId, sourceId],
    );
    await tx.query(
      "insert into question_version_knowledge_points (question_version_id, knowledge_point_id) values ($1, $2)",
      [publishedQuestionVersionId, firstPointId],
    );
    await tx.query("update question_versions set review_state = 'published' where id = $1", [publishedQuestionVersionId]);
  });

  return {
    firstPointId,
    secondPointId,
    ownerPointId,
    questionId,
    publishedKnowledgeVersionId,
    publishedQuestionVersionId,
  };
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
    expect(tags).toContain("0005_versioned_content_relationships");
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

  it("uses the built journal to lock relationship snapshots and their published lifecycle", async () => {
    const fixture = await createBuiltRelationshipSnapshotFixture();

    await expect(pglite!.query(
      "update question_version_knowledge_points set knowledge_point_id = $1 where question_version_id = $2 and knowledge_point_id = $3",
      [fixture.secondPointId, fixture.publishedQuestionVersionId, fixture.firstPointId],
    )).rejects.toThrow();
    await expect(pglite!.query(
      "delete from knowledge_point_version_prerequisites where knowledge_point_version_id = $1 and prerequisite_knowledge_point_id = $2",
      [fixture.publishedKnowledgeVersionId, fixture.firstPointId],
    )).rejects.toThrow();
    await expect(pglite!.query(
      "update question_versions set review_state = 'draft' where id = $1",
      [fixture.publishedQuestionVersionId],
    )).rejects.toThrow();
    await expect(pglite!.query(
      "update knowledge_point_versions set review_state = 'in_review' where id = $1",
      [fixture.publishedKnowledgeVersionId],
    )).rejects.toThrow();
  });

  it("uses the built journal to reject direct deletion of a published question version", async () => {
    const fixture = await createBuiltRelationshipSnapshotFixture();

    await expect(pglite!.query("delete from question_versions where id = $1", [fixture.publishedQuestionVersionId]))
      .rejects.toThrow();
  });

  it("uses the built journal to reject a published question owner cascade", async () => {
    const fixture = await createBuiltRelationshipSnapshotFixture();

    await expect(pglite!.query("delete from questions where id = $1", [fixture.questionId])).rejects.toThrow();
  });

  it("uses the built journal to reject direct deletion of a published knowledge version", async () => {
    const fixture = await createBuiltRelationshipSnapshotFixture();

    await expect(pglite!.query("delete from knowledge_point_versions where id = $1", [fixture.publishedKnowledgeVersionId]))
      .rejects.toThrow();
  });

  it("uses the built journal to reject a published knowledge owner cascade", async () => {
    const fixture = await createBuiltRelationshipSnapshotFixture();

    await expect(pglite!.query("delete from knowledge_points where id = $1", [fixture.ownerPointId])).rejects.toThrow();
  });
});
