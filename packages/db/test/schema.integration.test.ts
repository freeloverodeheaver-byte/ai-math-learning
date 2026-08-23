import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import {
  auditEvents,
  contentBundles,
  contentBundleVersions,
  contentEntityOwners,
  knowledgePoints,
  knowledgePrerequisites,
  knowledgePointVersionPrerequisites,
  knowledgePointVersions,
  questionKnowledgePoints,
  questionVersionKnowledgePoints,
  questionVersions,
  questions,
  sourceMergeProvenance,
  sources
} from "../src/schema";
import { applyJournaledMigrations } from "./migration-test-utils.js";

const testId = randomUUID();
const schemaFixtureBundleId = `schema-fixtures-${testId}`;
const pglite = await PGlite.create({ extensions: { pgcrypto } });
const db = drizzle(pglite, {
  schema: {
    auditEvents,
    contentBundles,
    contentBundleVersions,
    contentEntityOwners,
    knowledgePoints,
    knowledgePrerequisites,
    questionKnowledgePoints,
    questionVersionKnowledgePoints,
    questionVersions,
    questions,
    sourceMergeProvenance,
    sources
  }
});

beforeAll(async () => {
  await applyJournaledMigrations(pglite, new URL("../migrations/", import.meta.url));
  await db.insert(contentBundles).values({ bundleId: schemaFixtureBundleId });
});

afterAll(async () => {
  await pglite.close();
});

async function insertOwnedKnowledgePoint(value: typeof knowledgePoints.$inferInsert) {
  return db.transaction(async (tx) => {
    await tx.insert(contentEntityOwners).values({
      entityType: "knowledge",
      entityKey: value.canonicalId,
      bundleId: schemaFixtureBundleId
    });
    return tx.insert(knowledgePoints).values(value).returning();
  });
}

async function insertOwnedQuestion(value: typeof questions.$inferInsert) {
  return db.transaction(async (tx) => {
    await tx.insert(contentEntityOwners).values({
      entityType: "question",
      entityKey: value.externalKey,
      bundleId: schemaFixtureBundleId
    });
    return tx.insert(questions).values(value).returning();
  });
}

describe("foundation schema", () => {
  it("rejects updating and deleting audit events at the database layer", async () => {
    const [event] = await db.insert(auditEvents).values({
      actorUserId: null,
      action: "audit.append-only.probe",
      subjectType: "audit_probe",
      subjectId: randomUUID(),
      metadata: { immutable: true }
    }).returning({ id: auditEvents.id });

    await expect(db.update(auditEvents)
      .set({ metadata: { immutable: false } })
      .where(eq(auditEvents.id, event!.id))).rejects.toThrow();
    await expect(db.delete(auditEvents)
      .where(eq(auditEvents.id, event!.id))).rejects.toThrow();
    await expect(db.select().from(auditEvents)
      .where(eq(auditEvents.id, event!.id))).resolves.toHaveLength(1);
  });

  it("keeps a stable question id while content versions change", async () => {
    const [question] = await insertOwnedQuestion({ externalKey: `mock-q-${testId}` });

    await db.insert(questionVersions).values([
      {
        questionId: question.id,
        version: 1,
        stem: "1+1=?",
        answer: "2",
        explanation: "Add one and one.",
        reviewState: "draft"
      },
      {
        questionId: question.id,
        version: 2,
        stem: "1+1 等于多少？",
        answer: "2",
        explanation: "一与一相加。",
        reviewState: "draft"
      }
    ]);

    const rows = await db.select().from(questionVersions);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.questionId))).toEqual(new Set([question.id]));
  });

  it("rejects a prerequisite that does not target a known knowledge point", async () => {
    const [point] = await insertOwnedKnowledgePoint({
        canonicalId: `g7.valid.${testId}`,
        name: "Valid",
        grade: 7,
        semester: 1
      });

    await expect(
      db.insert(knowledgePrerequisites).values({
        knowledgePointId: point.id,
        prerequisiteKnowledgePointId: randomUUID()
      })
    ).rejects.toThrow();
  });

  it("rejects a knowledge point outside the supported junior-middle-school grades", async () => {
    await expect(
      insertOwnedKnowledgePoint({
        canonicalId: `invalid-grade-${randomUUID()}`,
        name: "Invalid",
        grade: 6,
        semester: 1
      })
    ).rejects.toThrow();
  });

  it("rejects a published question version without a source", async () => {
    const [question] = await insertOwnedQuestion({ externalKey: `missing-source-${randomUUID()}` });

    await expect(
      db.insert(questionVersions).values({
        questionId: question.id,
        version: 1,
        stem: "Source required",
        answer: "Yes",
        explanation: "Published questions require a source.",
        reviewState: "published"
      })
    ).rejects.toThrow();
  });

  it("rejects a published question version without a knowledge-point link", async () => {
    const [question] = await insertOwnedQuestion({ externalKey: `missing-link-${randomUUID()}` });
    const [source] = await db.insert(sources).values({ label: `Source ${randomUUID()}` }).returning();

    await expect(
      db.insert(questionVersions).values({
        questionId: question.id,
        version: 1,
        stem: "Knowledge link required",
        answer: "Yes",
        explanation: "Published questions require a knowledge-point link.",
        sourceId: source.id,
        reviewState: "published"
      })
    ).rejects.toThrow();
  });

  it("allows publishing content after its source and knowledge-point link exist", async () => {
    const [question] = await insertOwnedQuestion({ externalKey: `published-${randomUUID()}` });
    const [source] = await db.insert(sources).values({ label: `Source ${randomUUID()}` }).returning();
    const [point] = await insertOwnedKnowledgePoint({
      canonicalId: `published-point-${randomUUID()}`,
      name: "Published point",
      grade: 7,
      semester: 1
    });

    await db.transaction(async (tx) => {
      const [version] = await tx.insert(questionVersions).values({
        questionId: question.id,
        version: 1,
        stem: "Complete published question",
        answer: "Yes",
        explanation: "It has both required references.",
        sourceId: source.id,
        reviewState: "draft"
      }).returning({ id: questionVersions.id });
      await tx.insert(questionKnowledgePoints).values({ questionId: question.id, knowledgePointId: point.id });
      await tx.insert(questionVersionKnowledgePoints).values({ questionVersionId: version!.id, knowledgePointId: point.id });
      await tx.update(questionVersions).set({ reviewState: "published" })
        .where(eq(questionVersions.id, version!.id));
    });
  });

  it("rejects deleting the final knowledge-point link from a published question", async () => {
    const [question] = await insertOwnedQuestion({ externalKey: `final-link-${randomUUID()}` });
    const [source] = await db.insert(sources).values({ label: `Source ${randomUUID()}` }).returning();
    const [point] = await insertOwnedKnowledgePoint({
      canonicalId: `final-link-point-${randomUUID()}`,
      name: "Final link point",
      grade: 7,
      semester: 1
    });

    await db.transaction(async (tx) => {
      await tx.insert(questionKnowledgePoints).values({ questionId: question.id, knowledgePointId: point.id });
      const [version] = await tx.insert(questionVersions).values({
        questionId: question.id,
        version: 1,
        stem: "Published with one link",
        answer: "Yes",
        explanation: "Removing the last link must fail.",
        sourceId: source.id,
        reviewState: "draft"
      }).returning({ id: questionVersions.id });
      await tx.insert(questionVersionKnowledgePoints).values({ questionVersionId: version!.id, knowledgePointId: point.id });
      await tx.update(questionVersions).set({ reviewState: "published" })
        .where(eq(questionVersions.id, version!.id));
    });

    await expect(
      db.transaction(async (tx) => {
        const [version] = await tx.select({ id: questionVersions.id }).from(questionVersions)
          .where(eq(questionVersions.questionId, question.id));
        await tx.delete(questionVersionKnowledgePoints).where(and(
          eq(questionVersionKnowledgePoints.questionVersionId, version!.id),
          eq(questionVersionKnowledgePoints.knowledgePointId, point.id)
        ));
      })
    ).rejects.toThrow();
  });

  it("allows replacing a published question knowledge-point link in one transaction", async () => {
    const [question] = await insertOwnedQuestion({ externalKey: `replace-link-${randomUUID()}` });
    const [source] = await db.insert(sources).values({ label: `Source ${randomUUID()}` }).returning();
    const [firstPoint] = await insertOwnedKnowledgePoint({
      canonicalId: `replace-first-${randomUUID()}`,
      name: "First point",
      grade: 7,
      semester: 1
    });
    const [secondPoint] = await insertOwnedKnowledgePoint({
      canonicalId: `replace-second-${randomUUID()}`,
      name: "Second point",
      grade: 7,
      semester: 1
    });

    await db.transaction(async (tx) => {
      await tx.insert(questionKnowledgePoints).values({ questionId: question.id, knowledgePointId: firstPoint.id });
      const [version] = await tx.insert(questionVersions).values({
        questionId: question.id,
        version: 1,
        stem: "Published before replacement",
        answer: "Yes",
        explanation: "Replacing links in one transaction is valid.",
        sourceId: source.id,
        reviewState: "draft"
      }).returning({ id: questionVersions.id });
      await tx.insert(questionVersionKnowledgePoints).values({ questionVersionId: version!.id, knowledgePointId: firstPoint.id });
      await tx.update(questionVersions).set({ reviewState: "published" })
        .where(eq(questionVersions.id, version!.id));
    });

    await expect(
      db.transaction(async (tx) => {
        await tx.delete(questionKnowledgePoints).where(and(
          eq(questionKnowledgePoints.questionId, question.id),
          eq(questionKnowledgePoints.knowledgePointId, firstPoint.id)
        ));
        await tx.insert(questionKnowledgePoints).values({ questionId: question.id, knowledgePointId: secondPoint.id });
      })
    ).resolves.toBeUndefined();
  });

  it("rejects every direct mutation of a published question relationship snapshot", async () => {
    const fixture = await createRelationshipSnapshotFixture();

    await expect(db.update(questionVersionKnowledgePoints)
      .set({ knowledgePointId: fixture.secondPointId })
      .where(and(
        eq(questionVersionKnowledgePoints.questionVersionId, fixture.publishedQuestionVersionId),
        eq(questionVersionKnowledgePoints.knowledgePointId, fixture.firstPointId)
      ))).rejects.toThrow();
    await expect(db.update(questionVersionKnowledgePoints)
      .set({ questionVersionId: fixture.draftQuestionVersionId })
      .where(and(
        eq(questionVersionKnowledgePoints.questionVersionId, fixture.publishedQuestionVersionId),
        eq(questionVersionKnowledgePoints.knowledgePointId, fixture.firstPointId)
      ))).rejects.toThrow();
    await expect(db.transaction(async (tx) => {
      await tx.delete(questionVersionKnowledgePoints).where(and(
        eq(questionVersionKnowledgePoints.questionVersionId, fixture.publishedQuestionVersionId),
        eq(questionVersionKnowledgePoints.knowledgePointId, fixture.firstPointId)
      ));
      await tx.insert(questionVersionKnowledgePoints).values({
        questionVersionId: fixture.publishedQuestionVersionId,
        knowledgePointId: fixture.secondPointId
      });
    })).rejects.toThrow();
    await expect(db.insert(questionVersionKnowledgePoints).values({
      questionVersionId: fixture.publishedQuestionVersionId,
      knowledgePointId: fixture.thirdPointId
    })).rejects.toThrow();
    await expect(db.update(questionVersionKnowledgePoints)
      .set({ questionVersionId: fixture.publishedQuestionVersionId })
      .where(and(
        eq(questionVersionKnowledgePoints.questionVersionId, fixture.draftQuestionVersionId),
        eq(questionVersionKnowledgePoints.knowledgePointId, fixture.thirdPointId)
      ))).rejects.toThrow();
    await expect(db.update(questionVersionKnowledgePoints)
      .set({
        questionVersionId: fixture.publishedQuestionVersionId,
        knowledgePointId: fixture.secondPointId
      })
      .where(and(
        eq(questionVersionKnowledgePoints.questionVersionId, fixture.draftQuestionVersionId),
        eq(questionVersionKnowledgePoints.knowledgePointId, fixture.thirdPointId)
      ))).rejects.toThrow();
  });

  it("rejects every direct mutation of a published knowledge prerequisite snapshot", async () => {
    const fixture = await createRelationshipSnapshotFixture();

    await expect(db.update(knowledgePointVersionPrerequisites)
      .set({ prerequisiteKnowledgePointId: fixture.secondPointId })
      .where(and(
        eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.publishedKnowledgeVersionId),
        eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.firstPointId)
      ))).rejects.toThrow();
    await expect(db.update(knowledgePointVersionPrerequisites)
      .set({ knowledgePointVersionId: fixture.draftKnowledgeVersionId })
      .where(and(
        eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.publishedKnowledgeVersionId),
        eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.firstPointId)
      ))).rejects.toThrow();
    await expect(db.transaction(async (tx) => {
      await tx.delete(knowledgePointVersionPrerequisites).where(and(
        eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.publishedKnowledgeVersionId),
        eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.firstPointId)
      ));
      await tx.insert(knowledgePointVersionPrerequisites).values({
        knowledgePointVersionId: fixture.publishedKnowledgeVersionId,
        prerequisiteKnowledgePointId: fixture.secondPointId
      });
    })).rejects.toThrow();
    await expect(db.insert(knowledgePointVersionPrerequisites).values({
      knowledgePointVersionId: fixture.publishedKnowledgeVersionId,
      prerequisiteKnowledgePointId: fixture.thirdPointId
    })).rejects.toThrow();
    await expect(db.update(knowledgePointVersionPrerequisites)
      .set({ knowledgePointVersionId: fixture.publishedKnowledgeVersionId })
      .where(and(
        eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.draftKnowledgeVersionId),
        eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.thirdPointId)
      ))).rejects.toThrow();
    await expect(db.update(knowledgePointVersionPrerequisites)
      .set({
        knowledgePointVersionId: fixture.publishedKnowledgeVersionId,
        prerequisiteKnowledgePointId: fixture.secondPointId
      })
      .where(and(
        eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.draftKnowledgeVersionId),
        eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.thirdPointId)
      ))).rejects.toThrow();
  });

  it.each([
    ["a published question target update", (fixture: RelationshipSnapshotFixture) => db.update(questionVersionKnowledgePoints)
      .set({ knowledgePointId: fixture.secondPointId })
      .where(and(eq(questionVersionKnowledgePoints.questionVersionId, fixture.publishedQuestionVersionId), eq(questionVersionKnowledgePoints.knowledgePointId, fixture.firstPointId)))],
    ["a published question owner reassignment", (fixture: RelationshipSnapshotFixture) => db.update(questionVersionKnowledgePoints)
      .set({ questionVersionId: fixture.draftQuestionVersionId })
      .where(and(eq(questionVersionKnowledgePoints.questionVersionId, fixture.publishedQuestionVersionId), eq(questionVersionKnowledgePoints.knowledgePointId, fixture.firstPointId)))],
    ["a question reassignment into a published owner", (fixture: RelationshipSnapshotFixture) => db.update(questionVersionKnowledgePoints)
      .set({ questionVersionId: fixture.publishedQuestionVersionId })
      .where(and(eq(questionVersionKnowledgePoints.questionVersionId, fixture.draftQuestionVersionId), eq(questionVersionKnowledgePoints.knowledgePointId, fixture.thirdPointId)))],
    ["a published question delete and replacement", (fixture: RelationshipSnapshotFixture) => db.transaction(async (tx) => {
      await tx.delete(questionVersionKnowledgePoints).where(and(eq(questionVersionKnowledgePoints.questionVersionId, fixture.publishedQuestionVersionId), eq(questionVersionKnowledgePoints.knowledgePointId, fixture.firstPointId)));
      await tx.insert(questionVersionKnowledgePoints).values({ questionVersionId: fixture.publishedQuestionVersionId, knowledgePointId: fixture.secondPointId });
    })],
    ["an insert into a published question", (fixture: RelationshipSnapshotFixture) => db.insert(questionVersionKnowledgePoints)
      .values({ questionVersionId: fixture.publishedQuestionVersionId, knowledgePointId: fixture.thirdPointId })],
    ["a combined question owner and target update into a published owner", (fixture: RelationshipSnapshotFixture) => db.update(questionVersionKnowledgePoints)
      .set({ questionVersionId: fixture.publishedQuestionVersionId, knowledgePointId: fixture.secondPointId })
      .where(and(eq(questionVersionKnowledgePoints.questionVersionId, fixture.draftQuestionVersionId), eq(questionVersionKnowledgePoints.knowledgePointId, fixture.thirdPointId)))],
  ])("rejects %s independently", async (_name, mutation) => {
    await expect(mutation(await createRelationshipSnapshotFixture())).rejects.toThrow();
  });

  it.each([
    ["a published knowledge prerequisite target update", (fixture: RelationshipSnapshotFixture) => db.update(knowledgePointVersionPrerequisites)
      .set({ prerequisiteKnowledgePointId: fixture.secondPointId })
      .where(and(eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.publishedKnowledgeVersionId), eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.firstPointId)))],
    ["a published knowledge prerequisite owner reassignment", (fixture: RelationshipSnapshotFixture) => db.update(knowledgePointVersionPrerequisites)
      .set({ knowledgePointVersionId: fixture.draftKnowledgeVersionId })
      .where(and(eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.publishedKnowledgeVersionId), eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.firstPointId)))],
    ["a prerequisite reassignment into a published owner", (fixture: RelationshipSnapshotFixture) => db.update(knowledgePointVersionPrerequisites)
      .set({ knowledgePointVersionId: fixture.publishedKnowledgeVersionId })
      .where(and(eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.draftKnowledgeVersionId), eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.thirdPointId)))],
    ["a published knowledge prerequisite delete and replacement", (fixture: RelationshipSnapshotFixture) => db.transaction(async (tx) => {
      await tx.delete(knowledgePointVersionPrerequisites).where(and(eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.publishedKnowledgeVersionId), eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.firstPointId)));
      await tx.insert(knowledgePointVersionPrerequisites).values({ knowledgePointVersionId: fixture.publishedKnowledgeVersionId, prerequisiteKnowledgePointId: fixture.secondPointId });
    })],
    ["an insert into a published knowledge prerequisite snapshot", (fixture: RelationshipSnapshotFixture) => db.insert(knowledgePointVersionPrerequisites)
      .values({ knowledgePointVersionId: fixture.publishedKnowledgeVersionId, prerequisiteKnowledgePointId: fixture.thirdPointId })],
    ["a combined knowledge owner and target update into a published owner", (fixture: RelationshipSnapshotFixture) => db.update(knowledgePointVersionPrerequisites)
      .set({ knowledgePointVersionId: fixture.publishedKnowledgeVersionId, prerequisiteKnowledgePointId: fixture.secondPointId })
      .where(and(eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.draftKnowledgeVersionId), eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.thirdPointId)))],
  ])("rejects %s independently", async (_name, mutation) => {
    await expect(mutation(await createRelationshipSnapshotFixture())).rejects.toThrow();
  });

  it.each([
    ["a retired question insert", async (fixture: RelationshipSnapshotFixture) => {
      await db.update(questionVersions).set({ reviewState: "retired" }).where(eq(questionVersions.id, fixture.publishedQuestionVersionId));
      return db.insert(questionVersionKnowledgePoints).values({ questionVersionId: fixture.publishedQuestionVersionId, knowledgePointId: fixture.secondPointId });
    }],
    ["a retired question target update", async (fixture: RelationshipSnapshotFixture) => {
      await db.update(questionVersions).set({ reviewState: "retired" }).where(eq(questionVersions.id, fixture.publishedQuestionVersionId));
      return db.update(questionVersionKnowledgePoints).set({ knowledgePointId: fixture.secondPointId }).where(and(eq(questionVersionKnowledgePoints.questionVersionId, fixture.publishedQuestionVersionId), eq(questionVersionKnowledgePoints.knowledgePointId, fixture.firstPointId)));
    }],
    ["a retired question reassignment", async (fixture: RelationshipSnapshotFixture) => {
      await db.update(questionVersions).set({ reviewState: "retired" }).where(eq(questionVersions.id, fixture.publishedQuestionVersionId));
      return db.update(questionVersionKnowledgePoints).set({ questionVersionId: fixture.publishedQuestionVersionId }).where(and(eq(questionVersionKnowledgePoints.questionVersionId, fixture.draftQuestionVersionId), eq(questionVersionKnowledgePoints.knowledgePointId, fixture.thirdPointId)));
    }],
    ["a retired combined question owner and target update", async (fixture: RelationshipSnapshotFixture) => {
      await db.update(questionVersions).set({ reviewState: "retired" }).where(eq(questionVersions.id, fixture.publishedQuestionVersionId));
      return db.update(questionVersionKnowledgePoints).set({ questionVersionId: fixture.publishedQuestionVersionId, knowledgePointId: fixture.secondPointId }).where(and(eq(questionVersionKnowledgePoints.questionVersionId, fixture.draftQuestionVersionId), eq(questionVersionKnowledgePoints.knowledgePointId, fixture.thirdPointId)));
    }],
    ["a retired knowledge prerequisite insert", async (fixture: RelationshipSnapshotFixture) => {
      await db.update(knowledgePointVersions).set({ reviewState: "retired" }).where(eq(knowledgePointVersions.id, fixture.publishedKnowledgeVersionId));
      return db.insert(knowledgePointVersionPrerequisites).values({ knowledgePointVersionId: fixture.publishedKnowledgeVersionId, prerequisiteKnowledgePointId: fixture.secondPointId });
    }],
    ["a retired knowledge prerequisite target update", async (fixture: RelationshipSnapshotFixture) => {
      await db.update(knowledgePointVersions).set({ reviewState: "retired" }).where(eq(knowledgePointVersions.id, fixture.publishedKnowledgeVersionId));
      return db.update(knowledgePointVersionPrerequisites).set({ prerequisiteKnowledgePointId: fixture.secondPointId }).where(and(eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.publishedKnowledgeVersionId), eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.firstPointId)));
    }],
    ["a retired knowledge prerequisite reassignment", async (fixture: RelationshipSnapshotFixture) => {
      await db.update(knowledgePointVersions).set({ reviewState: "retired" }).where(eq(knowledgePointVersions.id, fixture.publishedKnowledgeVersionId));
      return db.update(knowledgePointVersionPrerequisites).set({ knowledgePointVersionId: fixture.publishedKnowledgeVersionId }).where(and(eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.draftKnowledgeVersionId), eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.thirdPointId)));
    }],
    ["a retired combined knowledge owner and target update", async (fixture: RelationshipSnapshotFixture) => {
      await db.update(knowledgePointVersions).set({ reviewState: "retired" }).where(eq(knowledgePointVersions.id, fixture.publishedKnowledgeVersionId));
      return db.update(knowledgePointVersionPrerequisites).set({ knowledgePointVersionId: fixture.publishedKnowledgeVersionId, prerequisiteKnowledgePointId: fixture.secondPointId }).where(and(eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.draftKnowledgeVersionId), eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.thirdPointId)));
    }],
  ])("rejects %s independently", async (_name, mutation) => {
    await expect(mutation(await createRelationshipSnapshotFixture())).rejects.toThrow();
  });

  it("rejects a published question version downgrade", async () => {
    const fixture = await createRelationshipSnapshotFixture();

    await expect(db.update(questionVersions)
      .set({ reviewState: "draft" })
      .where(eq(questionVersions.id, fixture.publishedQuestionVersionId))).rejects.toThrow();
  });

  it("rejects a published knowledge version downgrade", async () => {
    const fixture = await createRelationshipSnapshotFixture();

    await expect(db.update(knowledgePointVersions)
      .set({ reviewState: "in_review" })
      .where(eq(knowledgePointVersions.id, fixture.publishedKnowledgeVersionId))).rejects.toThrow();
  });

  it("allows a published question version to retire", async () => {
    const fixture = await createRelationshipSnapshotFixture();

    await db.update(questionVersions)
      .set({ reviewState: "retired" })
      .where(eq(questionVersions.id, fixture.publishedQuestionVersionId));
    await expect(db.select({ reviewState: questionVersions.reviewState }).from(questionVersions)
      .where(eq(questionVersions.id, fixture.publishedQuestionVersionId))).resolves.toEqual([{ reviewState: "retired" }]);
  });

  it("allows a published knowledge version to retire", async () => {
    const fixture = await createRelationshipSnapshotFixture();

    await db.update(knowledgePointVersions)
      .set({ reviewState: "retired" })
      .where(eq(knowledgePointVersions.id, fixture.publishedKnowledgeVersionId));
    await expect(db.select({ reviewState: knowledgePointVersions.reviewState }).from(knowledgePointVersions)
      .where(eq(knowledgePointVersions.id, fixture.publishedKnowledgeVersionId))).resolves.toEqual([{ reviewState: "retired" }]);
  });

  it("keeps a retired question version terminal", async () => {
    const fixture = await createRelationshipSnapshotFixture();
    await db.update(questionVersions).set({ reviewState: "retired" })
      .where(eq(questionVersions.id, fixture.publishedQuestionVersionId));
    await expect(db.update(questionVersions)
      .set({ reviewState: "in_review" })
      .where(eq(questionVersions.id, fixture.publishedQuestionVersionId))).rejects.toThrow();
  });

  it("keeps a retired knowledge version terminal", async () => {
    const fixture = await createRelationshipSnapshotFixture();
    await db.update(knowledgePointVersions).set({ reviewState: "retired" })
      .where(eq(knowledgePointVersions.id, fixture.publishedKnowledgeVersionId));
    await expect(db.update(knowledgePointVersions)
      .set({ reviewState: "draft" })
      .where(eq(knowledgePointVersions.id, fixture.publishedKnowledgeVersionId))).rejects.toThrow();
  });

  it("keeps draft and in-review relationship snapshots editable", async () => {
    const fixture = await createRelationshipSnapshotFixture();

    await expect(db.update(questionVersionKnowledgePoints)
      .set({ knowledgePointId: fixture.secondPointId })
      .where(and(
        eq(questionVersionKnowledgePoints.questionVersionId, fixture.draftQuestionVersionId),
        eq(questionVersionKnowledgePoints.knowledgePointId, fixture.thirdPointId)
      ))).resolves.toMatchObject({ affectedRows: 1 });
    await expect(db.update(knowledgePointVersionPrerequisites)
      .set({ prerequisiteKnowledgePointId: fixture.secondPointId })
      .where(and(
        eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.draftKnowledgeVersionId),
        eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.thirdPointId)
      ))).resolves.toMatchObject({ affectedRows: 1 });
    await db.update(questionVersions).set({ reviewState: "in_review" })
      .where(eq(questionVersions.id, fixture.draftQuestionVersionId));
    await db.update(knowledgePointVersions).set({ reviewState: "in_review" })
      .where(eq(knowledgePointVersions.id, fixture.draftKnowledgeVersionId));
    await expect(db.transaction(async (tx) => {
      await tx.delete(questionVersionKnowledgePoints).where(and(
        eq(questionVersionKnowledgePoints.questionVersionId, fixture.draftQuestionVersionId),
        eq(questionVersionKnowledgePoints.knowledgePointId, fixture.secondPointId)
      ));
      await tx.insert(questionVersionKnowledgePoints).values({
        questionVersionId: fixture.draftQuestionVersionId,
        knowledgePointId: fixture.thirdPointId
      });
      await tx.delete(knowledgePointVersionPrerequisites).where(and(
        eq(knowledgePointVersionPrerequisites.knowledgePointVersionId, fixture.draftKnowledgeVersionId),
        eq(knowledgePointVersionPrerequisites.prerequisiteKnowledgePointId, fixture.secondPointId)
      ));
      await tx.insert(knowledgePointVersionPrerequisites).values({
        knowledgePointVersionId: fixture.draftKnowledgeVersionId,
        prerequisiteKnowledgePointId: fixture.thirdPointId
      });
    })).resolves.toBeUndefined();
  });

  it("rejects direct deletion of a published question version", async () => {
    const fixture = await createRelationshipSnapshotFixture();

    await expect(db.delete(questionVersions)
      .where(eq(questionVersions.id, fixture.publishedQuestionVersionId))).rejects.toThrow();
  });

  it("rejects deleting a published question stable owner through its version cascade", async () => {
    const fixture = await createRelationshipSnapshotFixture();

    await expect(db.delete(questions).where(eq(questions.id, fixture.questionId))).rejects.toThrow();
  });

  it("rejects direct deletion of a published knowledge version", async () => {
    const fixture = await createRelationshipSnapshotFixture();

    await expect(db.delete(knowledgePointVersions)
      .where(eq(knowledgePointVersions.id, fixture.publishedKnowledgeVersionId))).rejects.toThrow();
  });

  it("rejects deleting a published knowledge stable owner through its version cascade", async () => {
    const fixture = await createRelationshipSnapshotFixture();

    await expect(db.delete(knowledgePoints).where(eq(knowledgePoints.id, fixture.knowledgePointId))).rejects.toThrow();
  });

  it("keeps direct deletion of editable versions available", async () => {
    const fixture = await createRelationshipSnapshotFixture();

    await expect(db.delete(questionVersions)
      .where(eq(questionVersions.id, fixture.draftQuestionVersionId))).resolves.toMatchObject({ affectedRows: 1 });
    await expect(db.delete(knowledgePointVersions)
      .where(eq(knowledgePointVersions.id, fixture.draftKnowledgeVersionId))).resolves.toMatchObject({ affectedRows: 1 });
  });

  it("declares the named anti-self prerequisite check", () => {
    expect(getTableConfig(knowledgePrerequisites).checks.map((constraint) => constraint.name))
      .toContain("knowledge_prerequisites_not_self");
  });

  it("enforces bundle tracking and entity ownership constraints from the full migration journal", async () => {
    const bundleId = `bundle-${randomUUID()}`;
    await db.insert(contentBundles).values({ bundleId });
    await db.insert(contentBundleVersions).values({ bundleId, version: 1, payloadHash: "a".repeat(64) });
    await db.insert(contentEntityOwners).values({
      entityType: "knowledge",
      entityKey: `knowledge-${randomUUID()}`,
      bundleId
    });

    await expect(db.insert(contentBundleVersions).values({
      bundleId,
      version: 0,
      payloadHash: "b".repeat(64)
    })).rejects.toThrow();
    await expect(db.insert(contentEntityOwners).values({
      entityType: "invalid",
      entityKey: `invalid-${randomUUID()}`,
      bundleId
    })).rejects.toThrow();

    const indexes = await pglite.query<{ indexname: string }>(
      "select indexname from pg_indexes where indexname in ('sources_label_unique', 'content_bundle_versions_bundle_version_unique') order by indexname"
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "content_bundle_versions_bundle_version_unique",
      "sources_label_unique"
    ]);
    expect(getTableConfig(contentBundleVersions).checks.map((constraint) => constraint.name))
      .toContain("content_bundle_versions_version_check");
    expect(getTableConfig(contentEntityOwners).checks.map((constraint) => constraint.name))
      .toContain("content_entity_owners_type_check");
    await expect(db.select().from(sourceMergeProvenance)).resolves.toEqual([]);
  });

  it("prevents deleting or re-keying an owner while its stable entity remains", async () => {
    const canonicalId = `owner-protected-${randomUUID()}`;
    await insertOwnedKnowledgePoint({
      canonicalId,
      name: "Owner protected",
      grade: 7,
      semester: 1
    });

    await expect(db.delete(contentEntityOwners).where(and(
      eq(contentEntityOwners.entityType, "knowledge"),
      eq(contentEntityOwners.entityKey, canonicalId)
    ))).rejects.toThrow(/owner/i);
    await expect(db.update(contentEntityOwners)
      .set({ entityKey: `${canonicalId}-moved` })
      .where(and(
        eq(contentEntityOwners.entityType, "knowledge"),
        eq(contentEntityOwners.entityKey, canonicalId)
      ))).rejects.toThrow(/owner/i);

    const survivingOwner = await db.select().from(contentEntityOwners).where(and(
      eq(contentEntityOwners.entityType, "knowledge"),
      eq(contentEntityOwners.entityKey, canonicalId)
    ));
    expect(survivingOwner).toHaveLength(1);
    const movedOwner = await db.select().from(contentEntityOwners)
      .where(eq(contentEntityOwners.entityKey, `${canonicalId}-moved`));
    expect(movedOwner).toEqual([]);

    const otherBundleId = `other-${randomUUID()}`;
    await db.insert(contentBundles).values({ bundleId: otherBundleId });
    await expect(db.update(contentEntityOwners).set({ bundleId: otherBundleId }).where(and(
      eq(contentEntityOwners.entityType, "knowledge"),
      eq(contentEntityOwners.entityKey, canonicalId)
    ))).rejects.toThrow();

    const removableCanonicalId = `owner-removable-${randomUUID()}`;
    await insertOwnedKnowledgePoint({
      canonicalId: removableCanonicalId,
      name: "Owner removable",
      grade: 7,
      semester: 1
    });
    await expect(db.transaction(async (tx) => {
      await tx.delete(knowledgePoints).where(eq(knowledgePoints.canonicalId, removableCanonicalId));
      await tx.delete(contentEntityOwners).where(and(
        eq(contentEntityOwners.entityType, "knowledge"),
        eq(contentEntityOwners.entityKey, removableCanonicalId)
      ));
    })).resolves.toBeUndefined();
  });

  it("prevents deleting or changing the type of a question owner while its stable entity remains", async () => {
    const externalKey = `question-owner-protected-${randomUUID()}`;
    await insertOwnedQuestion({ externalKey });

    await expect(db.delete(contentEntityOwners).where(and(
      eq(contentEntityOwners.entityType, "question"),
      eq(contentEntityOwners.entityKey, externalKey)
    ))).rejects.toThrow(/owner/i);
    await expect(db.update(contentEntityOwners)
      .set({ entityType: "knowledge" })
      .where(and(
        eq(contentEntityOwners.entityType, "question"),
        eq(contentEntityOwners.entityKey, externalKey)
      ))).rejects.toThrow(/owner/i);

    const survivingOwner = await db.select().from(contentEntityOwners).where(and(
      eq(contentEntityOwners.entityType, "question"),
      eq(contentEntityOwners.entityKey, externalKey)
    ));
    expect(survivingOwner).toHaveLength(1);
    const otherBundleId = `other-${randomUUID()}`;
    await db.insert(contentBundles).values({ bundleId: otherBundleId });
    await expect(db.update(contentEntityOwners).set({ bundleId: otherBundleId }).where(and(
      eq(contentEntityOwners.entityType, "question"),
      eq(contentEntityOwners.entityKey, externalKey)
    ))).rejects.toThrow();
  });
});

interface RelationshipSnapshotFixture {
  firstPointId: string;
  secondPointId: string;
  thirdPointId: string;
  fourthPointId: string;
  knowledgePointId: string;
  questionId: string;
  publishedQuestionVersionId: string;
  draftQuestionVersionId: string;
  publishedKnowledgeVersionId: string;
  draftKnowledgeVersionId: string;
}

async function createRelationshipSnapshotFixture(): Promise<RelationshipSnapshotFixture> {
  const [firstPoint] = await insertOwnedKnowledgePoint({
    canonicalId: `relationship-first-${randomUUID()}`,
    name: "First relationship point",
    grade: 7,
    semester: 1
  });
  const [secondPoint] = await insertOwnedKnowledgePoint({
    canonicalId: `relationship-second-${randomUUID()}`,
    name: "Second relationship point",
    grade: 7,
    semester: 1
  });
  const [thirdPoint] = await insertOwnedKnowledgePoint({
    canonicalId: `relationship-third-${randomUUID()}`,
    name: "Third relationship point",
    grade: 7,
    semester: 1
  });
  const [fourthPoint] = await insertOwnedKnowledgePoint({
    canonicalId: `relationship-fourth-${randomUUID()}`,
    name: "Fourth relationship point",
    grade: 7,
    semester: 1
  });
  const [knowledgePoint] = await insertOwnedKnowledgePoint({
    canonicalId: `relationship-owner-${randomUUID()}`,
    name: "Relationship owner",
    grade: 7,
    semester: 1
  });
  const [question] = await insertOwnedQuestion({ externalKey: `relationship-question-${randomUUID()}` });
  const [source] = await db.insert(sources).values({ label: `Relationship source ${randomUUID()}` }).returning();

  const relationshipVersions = await db.transaction(async (tx) => {
    const [publishedKnowledgeVersion] = await tx.insert(knowledgePointVersions).values({
      knowledgePointId: knowledgePoint!.id,
      version: 1,
      name: "Published relationship owner",
      grade: 7,
      semester: 1,
      reviewState: "draft"
    }).returning({ id: knowledgePointVersions.id });
    const [draftKnowledgeVersion] = await tx.insert(knowledgePointVersions).values({
      knowledgePointId: knowledgePoint!.id,
      version: 2,
      name: "Draft relationship owner",
      grade: 7,
      semester: 1,
      reviewState: "draft"
    }).returning({ id: knowledgePointVersions.id });
    await tx.insert(knowledgePointVersionPrerequisites).values([
      { knowledgePointVersionId: publishedKnowledgeVersion!.id, prerequisiteKnowledgePointId: firstPoint!.id },
      { knowledgePointVersionId: draftKnowledgeVersion!.id, prerequisiteKnowledgePointId: thirdPoint!.id }
    ]);
    await tx.update(knowledgePointVersions).set({ reviewState: "published" })
      .where(eq(knowledgePointVersions.id, publishedKnowledgeVersion!.id));

    await tx.insert(questionKnowledgePoints).values({ questionId: question!.id, knowledgePointId: firstPoint!.id });
    const [publishedQuestionVersion] = await tx.insert(questionVersions).values({
      questionId: question!.id,
      version: 1,
      stem: "Published relationship question",
      answer: "Answer",
      explanation: "Explanation",
      sourceId: source!.id,
      reviewState: "draft"
    }).returning({ id: questionVersions.id });
    const [draftQuestionVersion] = await tx.insert(questionVersions).values({
      questionId: question!.id,
      version: 2,
      stem: "Draft relationship question",
      answer: "Answer",
      explanation: "Explanation",
      sourceId: source!.id,
      reviewState: "draft"
    }).returning({ id: questionVersions.id });
    await tx.insert(questionVersionKnowledgePoints).values([
      { questionVersionId: publishedQuestionVersion!.id, knowledgePointId: firstPoint!.id },
      { questionVersionId: publishedQuestionVersion!.id, knowledgePointId: fourthPoint!.id },
      { questionVersionId: draftQuestionVersion!.id, knowledgePointId: thirdPoint!.id }
    ]);
    await tx.update(questionVersions).set({ reviewState: "published" })
      .where(eq(questionVersions.id, publishedQuestionVersion!.id));

    return {
      publishedKnowledgeVersionId: publishedKnowledgeVersion!.id,
      draftKnowledgeVersionId: draftKnowledgeVersion!.id,
      publishedQuestionVersionId: publishedQuestionVersion!.id,
      draftQuestionVersionId: draftQuestionVersion!.id
    };
  });

  return {
    firstPointId: firstPoint!.id,
    secondPointId: secondPoint!.id,
    thirdPointId: thirdPoint!.id,
    fourthPointId: fourthPoint!.id,
    knowledgePointId: knowledgePoint!.id,
    questionId: question!.id,
    ...relationshipVersions
  };
}

interface AccessFixture {
  classId: string;
  studentProfileId: string;
  otherStudentProfileId: string;
}

async function createAccessFixture(target: PGlite = pglite): Promise<AccessFixture> {
  const guardianUserId = randomUUID();
  const studentUserId = randomUUID();
  const otherStudentUserId = randomUUID();
  const teacherUserId = randomUUID();
  const teacherProfileId = randomUUID();
  const studentProfileId = randomUUID();
  const otherStudentProfileId = randomUUID();
  const classId = randomUUID();

  await target.query(
    `insert into users (id, external_subject) values
      ($1, $2), ($3, $4), ($5, $6), ($7, $8)`,
    [
      guardianUserId, `guardian-${guardianUserId}`,
      studentUserId, `student-${studentUserId}`,
      otherStudentUserId, `student-${otherStudentUserId}`,
      teacherUserId, `teacher-${teacherUserId}`,
    ],
  );
  await target.query(
    `insert into student_profiles (id, user_id, display_name, grade, semester) values
      ($1, $2, 'Student', 7, 1), ($3, $4, 'Other student', 8, 2)`,
    [studentProfileId, studentUserId, otherStudentProfileId, otherStudentUserId],
  );
  await target.query(
    "insert into teacher_profiles (id, user_id, display_name) values ($1, $2, 'Teacher')",
    [teacherProfileId, teacherUserId],
  );
  await target.query(
    "insert into classes (id, teacher_profile_id, name, subject, invite_code) values ($1, $2, 'Class', 'math', $3)",
    [classId, teacherProfileId, `invite-${classId}`],
  );

  return { classId, studentProfileId, otherStudentProfileId };
}

describe("access migration invariants", () => {
  it("allows only one requested or active membership for a class and student", async () => {
    const fixture = await createAccessFixture();
    await pglite.query(
      "insert into class_memberships (class_id, student_profile_id, state) values ($1, $2, 'requested')",
      [fixture.classId, fixture.studentProfileId],
    );

    await expect(pglite.query(
      "insert into class_memberships (class_id, student_profile_id, state) values ($1, $2, 'requested')",
      [fixture.classId, fixture.studentProfileId],
    )).rejects.toThrow();
  });

  it("requires resolved_at exactly when a membership is not requested", async () => {
    const fixture = await createAccessFixture();

    await expect(pglite.query(
      "insert into class_memberships (class_id, student_profile_id, state, resolved_at) values ($1, $2, 'rejected', null)",
      [fixture.classId, fixture.studentProfileId],
    )).rejects.toThrow();
    await expect(pglite.query(
      "insert into class_memberships (class_id, student_profile_id, state, resolved_at) values ($1, $2, 'requested', now())",
      [fixture.classId, fixture.otherStudentProfileId],
    )).rejects.toThrow();
  });

  it("rejects an active grant for a non-active membership or a different student", async () => {
    const fixture = await createAccessFixture();
    const requestedMembershipId = randomUUID();
    await pglite.query(
      "insert into class_memberships (id, class_id, student_profile_id, state) values ($1, $2, $3, 'requested')",
      [requestedMembershipId, fixture.classId, fixture.studentProfileId],
    );

    await expect(pglite.transaction(async (tx) => {
      await tx.query(
        "insert into data_sharing_grants (class_membership_id, student_profile_id, scope) values ($1, $2, 'learning_summary')",
        [requestedMembershipId, fixture.studentProfileId],
      );
    })).rejects.toThrow();

    const activeMembershipId = randomUUID();
    await pglite.query(
      "insert into class_memberships (id, class_id, student_profile_id, state, resolved_at) values ($1, $2, $3, 'active', now())",
      [activeMembershipId, fixture.classId, fixture.otherStudentProfileId],
    );
    await expect(pglite.transaction(async (tx) => {
      await tx.query(
        "insert into data_sharing_grants (class_membership_id, student_profile_id, scope) values ($1, $2, 'learning_summary')",
        [activeMembershipId, fixture.studentProfileId],
      );
    })).rejects.toThrow();
  });

  it("cannot leave an active membership while an unrevoked grant remains", async () => {
    const fixture = await createAccessFixture();
    const membershipId = randomUUID();
    await pglite.transaction(async (tx) => {
      await tx.query(
        "insert into class_memberships (id, class_id, student_profile_id, state, resolved_at) values ($1, $2, $3, 'active', now())",
        [membershipId, fixture.classId, fixture.studentProfileId],
      );
      await tx.query(
        "insert into data_sharing_grants (class_membership_id, student_profile_id, scope) values ($1, $2, 'learning_summary')",
        [membershipId, fixture.studentProfileId],
      );
    });

    await expect(pglite.transaction(async (tx) => {
      await tx.query(
        "update class_memberships set state = 'revoked', resolved_at = now() where id = $1",
        [membershipId],
      );
    })).rejects.toThrow();
  });

  it("rejects data sharing grant scopes outside the explicit sharing vocabulary", async () => {
    const fixture = await createAccessFixture();
    const membershipId = randomUUID();
    await pglite.query(
      "insert into class_memberships (id, class_id, student_profile_id, state, resolved_at) values ($1, $2, $3, 'active', now())",
      [membershipId, fixture.classId, fixture.studentProfileId],
    );

    await expect(pglite.query(
      "insert into data_sharing_grants (class_membership_id, student_profile_id, scope) values ($1, $2, 'all_student_data')",
      [membershipId, fixture.studentProfileId],
    )).rejects.toThrow();
  });

  it("prevents rebinding an approved membership to another class", async () => {
    const fixture = await createAccessFixture();
    const membershipId = randomUUID();
    const otherClassId = randomUUID();
    await pglite.query(
      `insert into classes (id, teacher_profile_id, name, subject, invite_code)
       select $1, teacher_profile_id, 'Other class', 'math', $2 from classes where id = $3`,
      [otherClassId, `invite-${otherClassId}`, fixture.classId],
    );
    await pglite.transaction(async (tx) => {
      await tx.query(
        "insert into class_memberships (id, class_id, student_profile_id, state, resolved_at) values ($1, $2, $3, 'active', now())",
        [membershipId, fixture.classId, fixture.studentProfileId],
      );
      await tx.query(
        "insert into data_sharing_grants (class_membership_id, student_profile_id, scope) values ($1, $2, 'learning_summary')",
        [membershipId, fixture.studentProfileId],
      );
    });

    await expect(pglite.transaction(async (tx) => {
      await tx.query("update class_memberships set class_id = $1 where id = $2", [otherClassId, membershipId]);
    })).rejects.toThrow(/active grant/i);

    await expect(pglite.transaction(async (tx) => {
      await tx.query(
        "update data_sharing_grants set revoked_at = now() where class_membership_id = $1",
        [membershipId],
      );
      await tx.query(
        "update class_memberships set class_id = $1, student_profile_id = $2 where id = $3",
        [otherClassId, fixture.otherStudentProfileId, membershipId],
      );
    })).resolves.toBeUndefined();
  });

  it("rejects atomically rebinding a membership and its unrevoked grant to another student", async () => {
    const fixture = await createAccessFixture();
    const membershipId = randomUUID();
    await pglite.transaction(async (tx) => {
      await tx.query(
        "insert into class_memberships (id, class_id, student_profile_id, state, resolved_at) values ($1, $2, $3, 'active', now())",
        [membershipId, fixture.classId, fixture.studentProfileId],
      );
      await tx.query(
        "insert into data_sharing_grants (class_membership_id, student_profile_id, scope) values ($1, $2, 'learning_summary')",
        [membershipId, fixture.studentProfileId],
      );
    });

    await expect(pglite.transaction(async (tx) => {
      await tx.query(
        "update class_memberships set student_profile_id = $1 where id = $2",
        [fixture.otherStudentProfileId, membershipId],
      );
      await tx.query(
        "update data_sharing_grants set student_profile_id = $1 where class_membership_id = $2",
        [fixture.otherStudentProfileId, membershipId],
      );
    })).rejects.toThrow(/active grant/i);
  });

  it("rejects moving an unrevoked grant but permits moving it after revocation", async () => {
    const fixture = await createAccessFixture();
    const sourceMembershipId = randomUUID();
    const targetMembershipId = randomUUID();
    const grantId = randomUUID();
    await pglite.transaction(async (tx) => {
      await tx.query(
        `insert into class_memberships (id, class_id, student_profile_id, state, resolved_at) values
          ($1, $3, $4, 'active', now()), ($2, $3, $5, 'active', now())`,
        [
          sourceMembershipId,
          targetMembershipId,
          fixture.classId,
          fixture.studentProfileId,
          fixture.otherStudentProfileId,
        ],
      );
      await tx.query(
        "insert into data_sharing_grants (id, class_membership_id, student_profile_id, scope) values ($1, $2, $3, 'learning_summary')",
        [grantId, sourceMembershipId, fixture.studentProfileId],
      );
    });

    await expect(pglite.transaction(async (tx) => {
      await tx.query(
        "update data_sharing_grants set class_membership_id = $1, student_profile_id = $2 where id = $3",
        [targetMembershipId, fixture.otherStudentProfileId, grantId],
      );
    })).rejects.toThrow(/unrevoked grant/i);

    await expect(pglite.transaction(async (tx) => {
      await tx.query("update data_sharing_grants set revoked_at = now() where id = $1", [grantId]);
      await tx.query(
        "update data_sharing_grants set class_membership_id = $1, student_profile_id = $2, scope = 'shared_personal_content' where id = $3",
        [targetMembershipId, fixture.otherStudentProfileId, grantId],
      );
    })).resolves.toBeUndefined();
  });

  it("rejects restoring a revoked grant after rebinding it", async () => {
    const fixture = await createAccessFixture();
    const sourceMembershipId = randomUUID();
    const targetMembershipId = randomUUID();
    const grantId = randomUUID();
    await pglite.transaction(async (tx) => {
      await tx.query(
        `insert into class_memberships (id, class_id, student_profile_id, state, resolved_at) values
          ($1, $3, $4, 'active', now()), ($2, $3, $5, 'active', now())`,
        [
          sourceMembershipId,
          targetMembershipId,
          fixture.classId,
          fixture.studentProfileId,
          fixture.otherStudentProfileId,
        ],
      );
      await tx.query(
        "insert into data_sharing_grants (id, class_membership_id, student_profile_id, scope) values ($1, $2, $3, 'learning_summary')",
        [grantId, sourceMembershipId, fixture.studentProfileId],
      );
    });

    await expect(pglite.transaction(async (tx) => {
      await tx.query("update data_sharing_grants set revoked_at = now() where id = $1", [grantId]);
      await tx.query(
        "update data_sharing_grants set class_membership_id = $1, student_profile_id = $2 where id = $3",
        [targetMembershipId, fixture.otherStudentProfileId, grantId],
      );
      await tx.query("update data_sharing_grants set revoked_at = null where id = $1", [grantId]);
    })).rejects.toThrow(/revocation/i);
  });

  it("rejects changing the approved scope of an unrevoked grant", async () => {
    const fixture = await createAccessFixture();
    const membershipId = randomUUID();
    const grantId = randomUUID();
    await pglite.transaction(async (tx) => {
      await tx.query(
        "insert into class_memberships (id, class_id, student_profile_id, state, resolved_at) values ($1, $2, $3, 'active', now())",
        [membershipId, fixture.classId, fixture.studentProfileId],
      );
      await tx.query(
        "insert into data_sharing_grants (id, class_membership_id, student_profile_id, scope) values ($1, $2, $3, 'learning_summary')",
        [grantId, membershipId, fixture.studentProfileId],
      );
    });

    await expect(pglite.transaction(async (tx) => {
      await tx.query(
        "update data_sharing_grants set scope = 'shared_personal_content' where id = $1",
        [grantId],
      );
    })).rejects.toThrow(/approved identity/i);
  });

  it("prevents transferring an approved class to another teacher until grants are revoked", async () => {
    const fixture = await createAccessFixture();
    const membershipId = randomUUID();
    const otherTeacherUserId = randomUUID();
    const otherTeacherProfileId = randomUUID();
    await pglite.query(
      "insert into users (id, external_subject) values ($1, $2)",
      [otherTeacherUserId, `teacher-${otherTeacherUserId}`],
    );
    await pglite.query(
      "insert into teacher_profiles (id, user_id, display_name) values ($1, $2, 'Other teacher')",
      [otherTeacherProfileId, otherTeacherUserId],
    );
    await pglite.transaction(async (tx) => {
      await tx.query(
        "insert into class_memberships (id, class_id, student_profile_id, state, resolved_at) values ($1, $2, $3, 'active', now())",
        [membershipId, fixture.classId, fixture.studentProfileId],
      );
      await tx.query(
        "insert into data_sharing_grants (class_membership_id, student_profile_id, scope) values ($1, $2, 'learning_summary')",
        [membershipId, fixture.studentProfileId],
      );
    });

    await expect(pglite.transaction(async (tx) => {
      await tx.query(
        "update classes set teacher_profile_id = $1 where id = $2",
        [otherTeacherProfileId, fixture.classId],
      );
    })).rejects.toThrow(/active grant/i);

    await expect(pglite.transaction(async (tx) => {
      await tx.query(
        "update data_sharing_grants set revoked_at = now() where class_membership_id = $1",
        [membershipId],
      );
      await tx.query(
        "update classes set teacher_profile_id = $1 where id = $2",
        [otherTeacherProfileId, fixture.classId],
      );
    })).resolves.toBeUndefined();
  });

  it("migrates legacy duplicate open memberships deterministically and audits each rejection", async () => {
    const legacy = await PGlite.create({ extensions: { pgcrypto } });
    try {
      const migrations = new URL("../migrations/", import.meta.url);
      await legacy.exec(await readFile(new URL("0000_foundation.sql", migrations), "utf8"));
      await legacy.exec(await readFile(new URL("0001_content_import_tracking.sql", migrations), "utf8"));
      const fixture = await createAccessFixture(legacy);
      const activeId = randomUUID();
      const firstRequestedId = randomUUID();
      const secondRequestedId = randomUUID();
      const rejectedId = randomUUID();
      const earliestOpenId = randomUUID();
      const laterOpenId = randomUUID();
      const unknownScopeGrantId = randomUUID();
      const inactiveMembershipGrantId = randomUUID();
      const mismatchedStudentGrantId = randomUUID();

      await legacy.query(
        `insert into class_memberships
          (id, class_id, student_profile_id, state, requested_at, resolved_at) values
          ($1, $2, $3, 'active', '2026-01-03T00:00:00Z', '2026-01-03T01:00:00Z'),
          ($4, $2, $3, 'requested', '2026-01-01T00:00:00Z', null),
          ($5, $2, $3, 'requested', '2026-01-02T00:00:00Z', null),
          ($6, $2, $7, 'rejected', '2026-01-04T00:00:00Z', null),
          ($8, $2, $7, 'requested', '2026-01-05T00:00:00Z', null),
          ($9, $2, $7, 'requested', '2026-01-06T00:00:00Z', null)`,
        [
          activeId,
          fixture.classId,
          fixture.studentProfileId,
          firstRequestedId,
          secondRequestedId,
          rejectedId,
          fixture.otherStudentProfileId,
          earliestOpenId,
          laterOpenId,
        ],
      );

      await legacy.query(
        `insert into data_sharing_grants
          (id, class_membership_id, student_profile_id, scope) values
          ($1, $2, $3, 'legacy_unknown_scope'),
          ($4, $5, $3, 'learning_summary'),
          ($6, $2, $7, 'shared_personal_content')`,
        [
          unknownScopeGrantId,
          activeId,
          fixture.studentProfileId,
          inactiveMembershipGrantId,
          firstRequestedId,
          mismatchedStudentGrantId,
          fixture.otherStudentProfileId,
        ],
      );

      await legacy.exec(await readFile(new URL("0002_access_invariants.sql", migrations), "utf8"));

      const rows = await legacy.query<{ id: string; state: string; resolved_at: Date | null }>(
        "select id, state, resolved_at from class_memberships where id = any($1::uuid[]) order by requested_at",
        [[activeId, firstRequestedId, secondRequestedId, rejectedId]],
      );
      expect(rows.rows).toEqual([
        expect.objectContaining({ id: firstRequestedId, state: "rejected", resolved_at: expect.any(Date) }),
        expect.objectContaining({ id: secondRequestedId, state: "rejected", resolved_at: expect.any(Date) }),
        expect.objectContaining({ id: activeId, state: "active", resolved_at: expect.any(Date) }),
        expect.objectContaining({ id: rejectedId, state: "rejected", resolved_at: expect.any(Date) }),
      ]);

      const noActivePair = await legacy.query<{ id: string; state: string; resolved_at: Date | null }>(
        "select id, state, resolved_at from class_memberships where id = any($1::uuid[]) order by requested_at",
        [[earliestOpenId, laterOpenId]],
      );
      expect(noActivePair.rows).toEqual([
        { id: earliestOpenId, state: "requested", resolved_at: null },
        expect.objectContaining({ id: laterOpenId, state: "rejected", resolved_at: expect.any(Date) }),
      ]);

      const audits = await legacy.query<{ subject_id: string; metadata: Record<string, unknown> }>(
        "select subject_id, metadata from audit_events where subject_id = any($1::text[]) order by subject_id",
        [[firstRequestedId, secondRequestedId, laterOpenId]],
      );
      expect(audits.rows).toHaveLength(3);
      expect(audits.rows.map((row) => row.subject_id)).toEqual(
        [firstRequestedId, secondRequestedId, laterOpenId].sort(),
      );
      expect(audits.rows.every((row) =>
        row.metadata.oldState === "requested" && row.metadata.newState === "rejected"
      )).toBe(true);

      const repairedGrants = await legacy.query<{ id: string; scope: string; revoked_at: Date | null }>(
        "select id, scope, revoked_at from data_sharing_grants where id = any($1::uuid[]) order by id",
        [[unknownScopeGrantId, inactiveMembershipGrantId, mismatchedStudentGrantId]],
      );
      expect(repairedGrants.rows).toHaveLength(3);
      expect(repairedGrants.rows.every((row) => row.revoked_at instanceof Date)).toBe(true);
      expect(new Set(repairedGrants.rows.map((row) => row.scope))).toEqual(new Set([
        "legacy_unknown_scope",
        "learning_summary",
        "shared_personal_content",
      ]));

      const grantAudits = await legacy.query<{ subject_id: string; metadata: Record<string, unknown> }>(
        `select subject_id, metadata from audit_events
         where action = 'data_sharing_grant.migration_revoked_invalid'
         order by subject_id`,
      );
      expect(grantAudits.rows).toHaveLength(3);
      expect(grantAudits.rows.map((row) => row.subject_id)).toEqual(
        [unknownScopeGrantId, inactiveMembershipGrantId, mismatchedStudentGrantId].sort(),
      );
    } finally {
      await legacy.close();
    }
  });
});
