import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ContentBundle } from "@math/contracts";
import {
  auditEvents,
  contentBundleVersions,
  contentEntityOwners,
  createDb,
  knowledgePoints,
  knowledgePointVersionPrerequisites,
  knowledgePointVersions,
  migrateDb,
  questionVersionKnowledgePoints,
  questionVersions,
  questions,
  type Database,
} from "@math/db";
import { and, count, eq, inArray } from "drizzle-orm";
import { AuditRepository } from "../src/modules/audit/repository.js";
import { AuditService } from "../src/modules/audit/service.js";
import { ContentImportWorkflow } from "../src/modules/content/import-workflow.js";
import { ContentRepository } from "../src/modules/content/repository.js";
import { ContentService, type ImportResult } from "../src/modules/content/service.js";
import {
  describePostgresRejection,
  isExpectedPostgresRejection,
} from "./native-content-integrity-support.js";

const QUESTION_RELATIONSHIP_LOCKED = "question version relationship snapshot is locked";
const KNOWLEDGE_RELATIONSHIP_LOCKED = "knowledge version prerequisite snapshot is locked";
const VERSION_DELETION_LOCKED = "locked content versions cannot be deleted";
const PUBLISHED_LIFECYCLE_LOCKED = "published content versions cannot return to an editable state";
const RETIRED_LIFECYCLE_LOCKED = "retired content versions are terminal";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error("native content integrity configuration [TEST_DATABASE_URL]: TEST_DATABASE_URL is required");
}

function diagnostic(invariant: string, identifier: string): string {
  return `${invariant} [${identifier}]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function verify<Result>(
  invariant: string,
  identifier: string,
  assertion: () => Promise<Result>,
): Promise<Result> {
  try {
    return await assertion();
  } catch (error) {
    const prefix = diagnostic(invariant, identifier);
    if (errorMessage(error).includes(prefix)) throw error;
    throw new Error(`${prefix}: ${errorMessage(error)}`, { cause: error });
  }
}

async function expectRejected(
  invariant: string,
  identifier: string,
  expectedMessage: string,
  mutation: () => Promise<unknown>,
): Promise<void> {
  try {
    await mutation();
  } catch (error) {
    if (isExpectedPostgresRejection(error, expectedMessage)) return;
    assert.fail(
      `${diagnostic(invariant, identifier)}: expected PostgreSQL P0001 "${expectedMessage}", received ${describePostgresRejection(error)}`,
    );
  }
  assert.fail(
    `${diagnostic(invariant, identifier)}: expected PostgreSQL P0001 "${expectedMessage}", but the mutation succeeded`,
  );
}

function createWorkflow(database: Database): ContentImportWorkflow {
  const repository = new ContentRepository();
  return new ContentImportWorkflow(
    database,
    new ContentService(database, repository),
    repository,
    new AuditService(new AuditRepository()),
  );
}

function uniqueBundle(fixture: ContentBundle, label: string): ContentBundle {
  const suffix = `${label}-${randomUUID()}`;
  const canonicalIds = new Map(
    fixture.knowledgePoints.map((point) => [point.canonicalId, `${point.canonicalId}.${suffix}`]),
  );
  return {
    ...fixture,
    bundleId: `${fixture.bundleId}-${suffix}`,
    knowledgePoints: fixture.knowledgePoints.map((point) => ({
      ...point,
      canonicalId: canonicalIds.get(point.canonicalId)!,
      prerequisites: point.prerequisites.map((canonicalId) => canonicalIds.get(canonicalId)!),
    })),
    questions: fixture.questions.map((question) => ({
      ...question,
      externalKey: `${question.externalKey}-${suffix}`,
      knowledgeCanonicalIds: question.knowledgeCanonicalIds.map(
        (canonicalId) => canonicalIds.get(canonicalId)!,
      ),
      sourceLabel: `${question.sourceLabel} ${suffix}`,
      sourceReference: `${question.sourceReference}:${suffix}`,
    })),
  };
}

async function loadFixture(): Promise<ContentBundle> {
  const fixtureUrl = new URL("../../../../seed/mock-content-grade-7-semester-1.json", import.meta.url);
  return JSON.parse(await readFile(fixtureUrl, "utf8")) as ContentBundle;
}

async function assertBundleCounts(
  database: Database,
  bundle: ContentBundle,
  auditEventsPerAction: number,
  invariant: string,
): Promise<void> {
  const identifier = bundle.bundleId;
  const canonicalIds = bundle.knowledgePoints.map((point) => point.canonicalId);
  const externalKeys = bundle.questions.map((question) => question.externalKey);

  const [stableKnowledgeCount] = await database
    .select({ value: count() })
    .from(knowledgePoints)
    .where(inArray(knowledgePoints.canonicalId, canonicalIds));
  assert.equal(
    stableKnowledgeCount?.value,
    3,
    `${diagnostic(invariant, identifier)}: expected exactly 3 stable knowledge records`,
  );

  const [stableQuestionCount] = await database
    .select({ value: count() })
    .from(questions)
    .where(inArray(questions.externalKey, externalKeys));
  assert.equal(
    stableQuestionCount?.value,
    2,
    `${diagnostic(invariant, identifier)}: expected exactly 2 stable question records`,
  );

  const [knowledgeVersionCount] = await database
    .select({ value: count() })
    .from(knowledgePointVersions)
    .innerJoin(knowledgePoints, eq(knowledgePointVersions.knowledgePointId, knowledgePoints.id))
    .where(and(
      inArray(knowledgePoints.canonicalId, canonicalIds),
      eq(knowledgePointVersions.reviewState, "published"),
    ));
  assert.equal(
    knowledgeVersionCount?.value,
    3,
    `${diagnostic(invariant, identifier)}: expected exactly 3 published knowledge versions`,
  );

  const [questionVersionCount] = await database
    .select({ value: count() })
    .from(questionVersions)
    .innerJoin(questions, eq(questionVersions.questionId, questions.id))
    .where(and(
      inArray(questions.externalKey, externalKeys),
      eq(questionVersions.reviewState, "published"),
    ));
  assert.equal(
    questionVersionCount?.value,
    2,
    `${diagnostic(invariant, identifier)}: expected exactly 2 published question versions`,
  );

  const [prerequisiteCount] = await database
    .select({ value: count() })
    .from(knowledgePointVersionPrerequisites)
    .innerJoin(
      knowledgePointVersions,
      eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, knowledgePointVersions.id),
    )
    .innerJoin(knowledgePoints, eq(knowledgePointVersions.knowledgePointId, knowledgePoints.id))
    .where(inArray(knowledgePoints.canonicalId, canonicalIds));
  assert.equal(
    prerequisiteCount?.value,
    2,
    `${diagnostic(invariant, identifier)}: expected exactly 2 knowledge prerequisite snapshots`,
  );

  const [questionLinkCount] = await database
    .select({ value: count() })
    .from(questionVersionKnowledgePoints)
    .innerJoin(
      questionVersions,
      eq(questionVersionKnowledgePoints.questionVersionId, questionVersions.id),
    )
    .innerJoin(questions, eq(questionVersions.questionId, questions.id))
    .where(inArray(questions.externalKey, externalKeys));
  assert.equal(
    questionLinkCount?.value,
    2,
    `${diagnostic(invariant, identifier)}: expected exactly 2 question relationship snapshots`,
  );

  const [ownerCount] = await database
    .select({ value: count() })
    .from(contentEntityOwners)
    .where(eq(contentEntityOwners.bundleId, bundle.bundleId));
  assert.equal(
    ownerCount?.value,
    5,
    `${diagnostic(invariant, identifier)}: expected exactly 5 stable content owners`,
  );

  const [bundleVersionCount] = await database
    .select({ value: count() })
    .from(contentBundleVersions)
    .where(eq(contentBundleVersions.bundleId, bundle.bundleId));
  assert.equal(
    bundleVersionCount?.value,
    1,
    `${diagnostic(invariant, identifier)}: expected exactly 1 bundle-version row`,
  );

  for (const action of ["content.bundle.imported", "content.bundle.published"] as const) {
    const [auditCount] = await database
      .select({ value: count() })
      .from(auditEvents)
      .where(and(
        eq(auditEvents.subjectId, bundle.bundleId),
        eq(auditEvents.action, action),
      ));
    assert.equal(
      auditCount?.value,
      auditEventsPerAction,
      `${diagnostic(invariant, identifier)}: expected exactly ${auditEventsPerAction} ${action} events`,
    );
  }
}

async function idempotentPublication(database: Database, fixture: ContentBundle): Promise<void> {
  const bundle = uniqueBundle(fixture, "idempotent");
  await verify("idempotent import and publication", bundle.bundleId, async () => {
    const workflow = createWorkflow(database);
    const first = await workflow.execute(bundle, { actor: null, metadata: { gate: "native-content" } });
    const second = await workflow.execute(bundle, { actor: null, metadata: { gate: "native-content" } });

    assert.deepEqual(first, {
      createdKnowledge: 3,
      createdQuestions: 2,
      newVersions: 0,
      unchanged: 0,
    }, `${diagnostic("idempotent import and publication", bundle.bundleId)}: first result`);
    assert.deepEqual(second, {
      createdKnowledge: 0,
      createdQuestions: 0,
      newVersions: 0,
      unchanged: 5,
    }, `${diagnostic("idempotent import and publication", bundle.bundleId)}: replay result`);
    await assertBundleCounts(database, bundle, 2, "idempotent import and publication");
  });
}

function isCreatedResult(result: ImportResult): boolean {
  return result.createdKnowledge === 3
    && result.createdQuestions === 2
    && result.newVersions === 0
    && result.unchanged === 0;
}

function isUnchangedResult(result: ImportResult): boolean {
  return result.createdKnowledge === 0
    && result.createdQuestions === 0
    && result.newVersions === 0
    && result.unchanged === 5;
}

async function concurrentPublication(
  databaseA: Database,
  databaseB: Database,
  fixture: ContentBundle,
): Promise<void> {
  const bundle = uniqueBundle(fixture, "concurrent");
  await verify("same-bundle concurrent import serialization", bundle.bundleId, async () => {
    const results = await Promise.all([
      createWorkflow(databaseA).execute(bundle, { actor: null, metadata: { lane: "A" } }),
      createWorkflow(databaseB).execute(bundle, { actor: null, metadata: { lane: "B" } }),
    ]);
    assert.equal(
      results.filter(isCreatedResult).length,
      1,
      `${diagnostic("same-bundle concurrent import serialization", bundle.bundleId)}: exactly one result must create 5 stable records`,
    );
    assert.equal(
      results.filter(isUnchangedResult).length,
      1,
      `${diagnostic("same-bundle concurrent import serialization", bundle.bundleId)}: exactly one result must report 5 unchanged items`,
    );
    await assertBundleCounts(databaseA, bundle, 2, "same-bundle concurrent import serialization");
  });
}

interface RelationshipFixture {
  bundleId: string;
  knowledgeCanonicalId: string;
  questionExternalKey: string;
  knowledgePointId: string;
  cascadeKnowledgeCanonicalId: string;
  cascadeKnowledgePointId: string;
  cascadeKnowledgeVersionId: string;
  questionId: string;
  primaryTargetId: string;
  alternateTargetId: string;
  thirdTargetId: string;
  publishedKnowledgeVersionId: string;
  draftKnowledgeVersionId: string;
  publishedQuestionVersionId: string;
  draftQuestionVersionId: string;
}

async function createRelationshipFixture(
  database: Database,
  sourceFixture: ContentBundle,
): Promise<RelationshipFixture> {
  const bundle = uniqueBundle(sourceFixture, "relationships");
  return verify("relationship fixture creation", bundle.bundleId, async () => {
    await createWorkflow(database).execute(bundle, { actor: null, metadata: { gate: "relationships" } });
    const repository = new ContentRepository();
    const [firstPoint, secondPoint, thirdPoint] = bundle.knowledgePoints;
    const [firstQuestion] = bundle.questions;

  const pointRows = await database
    .select({ id: knowledgePoints.id, canonicalId: knowledgePoints.canonicalId })
    .from(knowledgePoints)
    .where(inArray(knowledgePoints.canonicalId, [
      firstPoint!.canonicalId,
      secondPoint!.canonicalId,
      thirdPoint!.canonicalId,
    ]));
  const idByCanonicalId = new Map(pointRows.map((row) => [row.canonicalId, row.id]));
  const [question] = await database
    .select({ id: questions.id })
    .from(questions)
    .where(eq(questions.externalKey, firstQuestion!.externalKey));
  const [publishedKnowledgeVersion] = await database
    .select({ id: knowledgePointVersions.id, knowledgePointId: knowledgePoints.id })
    .from(knowledgePointVersions)
    .innerJoin(knowledgePoints, eq(knowledgePointVersions.knowledgePointId, knowledgePoints.id))
    .where(and(
      eq(knowledgePoints.canonicalId, secondPoint!.canonicalId),
      eq(knowledgePointVersions.reviewState, "published"),
    ));
  const [publishedQuestionVersion] = await database
    .select({ id: questionVersions.id })
    .from(questionVersions)
    .innerJoin(questions, eq(questionVersions.questionId, questions.id))
    .where(and(
      eq(questions.externalKey, firstQuestion!.externalKey),
      eq(questionVersions.reviewState, "published"),
    ));

  assert.ok(
    question && publishedKnowledgeVersion && publishedQuestionVersion,
    `${diagnostic("relationship fixture creation", bundle.bundleId)}: published owners must exist`,
  );

  const additionalVersions = await database.transaction(async (transaction) => {
    const draftKnowledgeVersionId = await repository.appendKnowledgeVersion(
      transaction,
      publishedKnowledgeVersion.knowledgePointId,
      3,
      { ...secondPoint!, prerequisites: [thirdPoint!.canonicalId] },
    );
    await repository.replaceKnowledgePrerequisites(
      transaction,
      draftKnowledgeVersionId,
      [idByCanonicalId.get(thirdPoint!.canonicalId)!],
    );
    const sourceId = await repository.upsertSource(transaction, {
      label: firstQuestion!.sourceLabel,
      kind: firstQuestion!.sourceKind,
      reference: firstQuestion!.sourceReference,
      usageBasis: firstQuestion!.sourceUsageBasis,
    });
    const draftQuestionVersionId = await repository.appendQuestionVersion(
      transaction,
      question.id,
      3,
      firstQuestion!,
      sourceId,
    );
    await repository.replaceQuestionKnowledgeLinks(
      transaction,
      draftQuestionVersionId,
      [idByCanonicalId.get(firstPoint!.canonicalId)!],
    );
    const cascadeKnowledgeCanonicalId = `cascade-knowledge-${randomUUID()}`;
    await repository.lockEntityOwner(transaction, bundle.bundleId, {
      entityType: "knowledge",
      entityKey: cascadeKnowledgeCanonicalId,
    });
    const cascadeKnowledge = await repository.upsertStableKnowledgePoint(transaction, {
      canonicalId: cascadeKnowledgeCanonicalId,
      name: "Cascade deletion knowledge owner",
      grade: 7,
      semester: 1,
      prerequisites: [],
    });
    const cascadeKnowledgeVersionId = await repository.appendKnowledgeVersion(
      transaction,
      cascadeKnowledge.id,
      2,
      {
        canonicalId: cascadeKnowledgeCanonicalId,
        name: "Cascade deletion knowledge owner",
        grade: 7,
        semester: 1,
        prerequisites: [],
      },
    );
    await transaction.update(knowledgePointVersions)
      .set({ reviewState: "published" })
      .where(eq(knowledgePointVersions.id, cascadeKnowledgeVersionId));
    return {
      draftKnowledgeVersionId,
      draftQuestionVersionId,
      cascadeKnowledgeCanonicalId,
      cascadeKnowledgePointId: cascadeKnowledge.id,
      cascadeKnowledgeVersionId,
    };
  });

    return {
      bundleId: bundle.bundleId,
      knowledgeCanonicalId: secondPoint!.canonicalId,
      questionExternalKey: firstQuestion!.externalKey,
      knowledgePointId: publishedKnowledgeVersion.knowledgePointId,
      questionId: question.id,
      primaryTargetId: idByCanonicalId.get(firstPoint!.canonicalId)!,
      alternateTargetId: idByCanonicalId.get(thirdPoint!.canonicalId)!,
      thirdTargetId: idByCanonicalId.get(secondPoint!.canonicalId)!,
      publishedKnowledgeVersionId: publishedKnowledgeVersion.id,
      publishedQuestionVersionId: publishedQuestionVersion.id,
      ...additionalVersions,
    };
  });
}

async function assertRelationshipMutationRowsExist(
  database: Database,
  fixture: RelationshipFixture,
  state: "published" | "retired",
): Promise<void> {
  const publishedQuestionRows = await database.select({
    questionVersionId: questionVersionKnowledgePoints.questionVersionId,
  }).from(questionVersionKnowledgePoints).where(and(
    eq(questionVersionKnowledgePoints.questionVersionId, fixture.publishedQuestionVersionId),
    eq(questionVersionKnowledgePoints.knowledgePointId, fixture.thirdTargetId),
  ));
  assert.equal(
    publishedQuestionRows.length,
    1,
    `${diagnostic(`${state} question relationship mutation precondition`, fixture.questionExternalKey)}: expected the locked UPDATE/DELETE row to exist`,
  );
  const draftQuestionRows = await database.select({
    questionVersionId: questionVersionKnowledgePoints.questionVersionId,
  }).from(questionVersionKnowledgePoints).where(and(
    eq(questionVersionKnowledgePoints.questionVersionId, fixture.draftQuestionVersionId),
    eq(questionVersionKnowledgePoints.knowledgePointId, fixture.primaryTargetId),
  ));
  assert.equal(
    draftQuestionRows.length,
    1,
    `${diagnostic(`${state} question owner-reassignment precondition`, fixture.questionExternalKey)}: expected the draft source row to exist`,
  );
  const publishedKnowledgeRows = await database.select({
    knowledgePointVersionId: knowledgePointVersionPrerequisites.knowledgePointVersionId,
  }).from(knowledgePointVersionPrerequisites).where(and(
    eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.publishedKnowledgeVersionId),
    eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.primaryTargetId),
  ));
  assert.equal(
    publishedKnowledgeRows.length,
    1,
    `${diagnostic(`${state} knowledge prerequisite mutation precondition`, fixture.knowledgeCanonicalId)}: expected the locked UPDATE/DELETE row to exist`,
  );
  const draftKnowledgeRows = await database.select({
    knowledgePointVersionId: knowledgePointVersionPrerequisites.knowledgePointVersionId,
  }).from(knowledgePointVersionPrerequisites).where(and(
    eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.draftKnowledgeVersionId),
    eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.alternateTargetId),
  ));
  assert.equal(
    draftKnowledgeRows.length,
    1,
    `${diagnostic(`${state} knowledge owner-reassignment precondition`, fixture.knowledgeCanonicalId)}: expected the draft source row to exist`,
  );
}

async function rejectQuestionRelationshipMatrix(
  database: Database,
  fixture: RelationshipFixture,
  state: "published" | "retired",
): Promise<void> {
  const invariant = `${state} question relationship snapshot immutability`;
  const id = fixture.questionExternalKey;
  await expectRejected(invariant, id, QUESTION_RELATIONSHIP_LOCKED, () => database.insert(questionVersionKnowledgePoints).values({
    questionVersionId: fixture.publishedQuestionVersionId,
    knowledgePointId: fixture.alternateTargetId,
  }));
  await expectRejected(invariant, id, QUESTION_RELATIONSHIP_LOCKED, () => database.update(questionVersionKnowledgePoints)
    .set({ knowledgePointId: fixture.alternateTargetId })
    .where(and(
      eq(questionVersionKnowledgePoints.questionVersionId, fixture.publishedQuestionVersionId),
      eq(questionVersionKnowledgePoints.knowledgePointId, fixture.thirdTargetId),
    )));
  await expectRejected(invariant, id, QUESTION_RELATIONSHIP_LOCKED, () => database.delete(questionVersionKnowledgePoints)
    .where(and(
      eq(questionVersionKnowledgePoints.questionVersionId, fixture.publishedQuestionVersionId),
      eq(questionVersionKnowledgePoints.knowledgePointId, fixture.thirdTargetId),
    )));
  await expectRejected(invariant, id, QUESTION_RELATIONSHIP_LOCKED, () => database.update(questionVersionKnowledgePoints)
    .set({ questionVersionId: fixture.draftQuestionVersionId })
    .where(and(
      eq(questionVersionKnowledgePoints.questionVersionId, fixture.publishedQuestionVersionId),
      eq(questionVersionKnowledgePoints.knowledgePointId, fixture.thirdTargetId),
    )));
  await expectRejected(invariant, id, QUESTION_RELATIONSHIP_LOCKED, () => database.update(questionVersionKnowledgePoints)
    .set({ questionVersionId: fixture.publishedQuestionVersionId })
    .where(and(
      eq(questionVersionKnowledgePoints.questionVersionId, fixture.draftQuestionVersionId),
      eq(questionVersionKnowledgePoints.knowledgePointId, fixture.primaryTargetId),
    )));
  await expectRejected(invariant, id, QUESTION_RELATIONSHIP_LOCKED, () => database.update(questionVersionKnowledgePoints)
    .set({
      questionVersionId: fixture.publishedQuestionVersionId,
      knowledgePointId: fixture.alternateTargetId,
    })
    .where(and(
      eq(questionVersionKnowledgePoints.questionVersionId, fixture.draftQuestionVersionId),
      eq(questionVersionKnowledgePoints.knowledgePointId, fixture.primaryTargetId),
    )));
  await expectRejected(invariant, id, QUESTION_RELATIONSHIP_LOCKED, () => database.transaction(async (transaction) => {
    await transaction.delete(questionVersionKnowledgePoints).where(and(
      eq(questionVersionKnowledgePoints.questionVersionId, fixture.publishedQuestionVersionId),
      eq(questionVersionKnowledgePoints.knowledgePointId, fixture.thirdTargetId),
    ));
    await transaction.insert(questionVersionKnowledgePoints).values({
      questionVersionId: fixture.publishedQuestionVersionId,
      knowledgePointId: fixture.alternateTargetId,
    });
  }));
}

async function rejectKnowledgeRelationshipMatrix(
  database: Database,
  fixture: RelationshipFixture,
  state: "published" | "retired",
): Promise<void> {
  const invariant = `${state} knowledge prerequisite snapshot immutability`;
  const id = fixture.knowledgeCanonicalId;
  await expectRejected(invariant, id, KNOWLEDGE_RELATIONSHIP_LOCKED, () => database.insert(knowledgePointVersionPrerequisites).values({
    knowledgePointVersionId: fixture.publishedKnowledgeVersionId,
    prerequisiteKnowledgePointId: fixture.alternateTargetId,
  }));
  await expectRejected(invariant, id, KNOWLEDGE_RELATIONSHIP_LOCKED, () => database.update(knowledgePointVersionPrerequisites)
    .set({ prerequisiteKnowledgePointId: fixture.alternateTargetId })
    .where(and(
      eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.publishedKnowledgeVersionId),
      eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.primaryTargetId),
    )));
  await expectRejected(invariant, id, KNOWLEDGE_RELATIONSHIP_LOCKED, () => database.delete(knowledgePointVersionPrerequisites)
    .where(and(
      eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.publishedKnowledgeVersionId),
      eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.primaryTargetId),
    )));
  await expectRejected(invariant, id, KNOWLEDGE_RELATIONSHIP_LOCKED, () => database.update(knowledgePointVersionPrerequisites)
    .set({ knowledgePointVersionId: fixture.draftKnowledgeVersionId })
    .where(and(
      eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.publishedKnowledgeVersionId),
      eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.primaryTargetId),
    )));
  await expectRejected(invariant, id, KNOWLEDGE_RELATIONSHIP_LOCKED, () => database.update(knowledgePointVersionPrerequisites)
    .set({ knowledgePointVersionId: fixture.publishedKnowledgeVersionId })
    .where(and(
      eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.draftKnowledgeVersionId),
      eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.alternateTargetId),
    )));
  await expectRejected(invariant, id, KNOWLEDGE_RELATIONSHIP_LOCKED, () => database.update(knowledgePointVersionPrerequisites)
    .set({
      knowledgePointVersionId: fixture.publishedKnowledgeVersionId,
      prerequisiteKnowledgePointId: fixture.thirdTargetId,
    })
    .where(and(
      eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.draftKnowledgeVersionId),
      eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.alternateTargetId),
    )));
  await expectRejected(invariant, id, KNOWLEDGE_RELATIONSHIP_LOCKED, () => database.transaction(async (transaction) => {
    await transaction.delete(knowledgePointVersionPrerequisites).where(and(
      eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.publishedKnowledgeVersionId),
      eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.primaryTargetId),
    ));
    await transaction.insert(knowledgePointVersionPrerequisites).values({
      knowledgePointVersionId: fixture.publishedKnowledgeVersionId,
      prerequisiteKnowledgePointId: fixture.alternateTargetId,
    });
  }));
}

async function assertVersionDeletionLocks(
  database: Database,
  fixture: RelationshipFixture,
  state: "published" | "retired",
): Promise<void> {
  await expectRejected(
    `${state} question version direct deletion lock`,
    fixture.questionExternalKey,
    VERSION_DELETION_LOCKED,
    () => database.delete(questionVersions)
      .where(eq(questionVersions.id, fixture.publishedQuestionVersionId)),
  );
  await expectRejected(
    `${state} knowledge version direct deletion lock`,
    fixture.knowledgeCanonicalId,
    VERSION_DELETION_LOCKED,
    () => database.delete(knowledgePointVersions)
      .where(eq(knowledgePointVersions.id, fixture.publishedKnowledgeVersionId)),
  );
  await expectRejected(
    `${state} question stable-owner cascade deletion lock`,
    fixture.questionExternalKey,
    VERSION_DELETION_LOCKED,
    () => database.delete(questions).where(eq(questions.id, fixture.questionId)),
  );
  await expectRejected(
    `${state} knowledge stable-owner cascade deletion lock`,
    fixture.cascadeKnowledgeCanonicalId,
    VERSION_DELETION_LOCKED,
    () => database.delete(knowledgePoints)
      .where(eq(knowledgePoints.id, fixture.cascadeKnowledgePointId)),
  );
}

async function assertPublishedLifecycle(database: Database, fixture: RelationshipFixture): Promise<void> {
  for (const reviewState of ["draft", "in_review"] as const) {
    await expectRejected(
      "published question may transition only to retired",
      fixture.questionExternalKey,
      PUBLISHED_LIFECYCLE_LOCKED,
      () => database.update(questionVersions)
        .set({ reviewState })
        .where(eq(questionVersions.id, fixture.publishedQuestionVersionId)),
    );
    await expectRejected(
      "published knowledge may transition only to retired",
      fixture.knowledgeCanonicalId,
      PUBLISHED_LIFECYCLE_LOCKED,
      () => database.update(knowledgePointVersions)
        .set({ reviewState })
        .where(eq(knowledgePointVersions.id, fixture.publishedKnowledgeVersionId)),
    );
  }

  await database.update(questionVersions)
    .set({ reviewState: "retired" })
    .where(eq(questionVersions.id, fixture.publishedQuestionVersionId));
  await database.update(knowledgePointVersions)
    .set({ reviewState: "retired" })
    .where(eq(knowledgePointVersions.id, fixture.publishedKnowledgeVersionId));
  await database.update(knowledgePointVersions)
    .set({ reviewState: "retired" })
    .where(eq(knowledgePointVersions.id, fixture.cascadeKnowledgeVersionId));

  const [questionState] = await database
    .select({ reviewState: questionVersions.reviewState })
    .from(questionVersions)
    .where(eq(questionVersions.id, fixture.publishedQuestionVersionId));
  const [knowledgeState] = await database
    .select({ reviewState: knowledgePointVersions.reviewState })
    .from(knowledgePointVersions)
    .where(eq(knowledgePointVersions.id, fixture.publishedKnowledgeVersionId));
  assert.equal(
    questionState?.reviewState,
    "retired",
    `${diagnostic("published question retirement transition", fixture.questionExternalKey)}: expected retired`,
  );
  assert.equal(
    knowledgeState?.reviewState,
    "retired",
    `${diagnostic("published knowledge retirement transition", fixture.knowledgeCanonicalId)}: expected retired`,
  );
}

async function assertRetiredLifecycle(database: Database, fixture: RelationshipFixture): Promise<void> {
  for (const reviewState of ["draft", "in_review", "published"] as const) {
    await expectRejected(
      "retired question version is terminal",
      fixture.questionExternalKey,
      RETIRED_LIFECYCLE_LOCKED,
      () => database.update(questionVersions)
        .set({ reviewState })
        .where(eq(questionVersions.id, fixture.publishedQuestionVersionId)),
    );
    await expectRejected(
      "retired knowledge version is terminal",
      fixture.knowledgeCanonicalId,
      RETIRED_LIFECYCLE_LOCKED,
      () => database.update(knowledgePointVersions)
        .set({ reviewState })
        .where(eq(knowledgePointVersions.id, fixture.publishedKnowledgeVersionId)),
    );
  }
}

async function assertEditableDraftDeletion(database: Database, fixture: RelationshipFixture): Promise<void> {
  const deletedQuestionVersions = await database.delete(questionVersions)
    .where(eq(questionVersions.id, fixture.draftQuestionVersionId))
    .returning({ id: questionVersions.id });
  assert.equal(
    deletedQuestionVersions.length,
    1,
    `${diagnostic("editable draft question version deletion", fixture.questionExternalKey)}: expected 1 deleted version`,
  );
  const deletedKnowledgeVersions = await database.delete(knowledgePointVersions)
    .where(eq(knowledgePointVersions.id, fixture.draftKnowledgeVersionId))
    .returning({ id: knowledgePointVersions.id });
  assert.equal(
    deletedKnowledgeVersions.length,
    1,
    `${diagnostic("editable draft knowledge version deletion", fixture.knowledgeCanonicalId)}: expected 1 deleted version`,
  );
}

async function relationshipAndLifecycleIntegrity(
  database: Database,
  fixtureSource: ContentBundle,
): Promise<void> {
  const fixture = await createRelationshipFixture(database, fixtureSource);
  await verify("published relationship and lifecycle integrity", fixture.bundleId, async () => {
    await assertRelationshipMutationRowsExist(database, fixture, "published");
    await rejectQuestionRelationshipMatrix(database, fixture, "published");
    await rejectKnowledgeRelationshipMatrix(database, fixture, "published");
    await assertVersionDeletionLocks(database, fixture, "published");
    await assertPublishedLifecycle(database, fixture);
  });
  await verify("retired relationship and lifecycle integrity", fixture.bundleId, async () => {
    await assertRelationshipMutationRowsExist(database, fixture, "retired");
    await rejectQuestionRelationshipMatrix(database, fixture, "retired");
    await rejectKnowledgeRelationshipMatrix(database, fixture, "retired");
    await assertVersionDeletionLocks(database, fixture, "retired");
    await assertRetiredLifecycle(database, fixture);
    await assertEditableDraftDeletion(database, fixture);
  });
}

const databaseA = createDb(connectionString);
const databaseB = createDb(connectionString);
assert.notEqual(
  databaseA.$client,
  databaseB.$client,
  "independent native database pools [TEST_DATABASE_URL]: expected distinct pg Pool instances",
);

try {
  await verify("committed migration replay", "TEST_DATABASE_URL", () => migrateDb(databaseA));
  const fixture = await loadFixture();
  await idempotentPublication(databaseA, fixture);
  await concurrentPublication(databaseA, databaseB, fixture);
  await relationshipAndLifecycleIntegrity(databaseA, fixture);
  console.log("Native content integrity assertions passed.");
} finally {
  await Promise.all([databaseA.$client.end(), databaseB.$client.end()]);
}
