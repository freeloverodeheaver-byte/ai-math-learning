import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import {
  contentBundles,
  contentBundleVersions,
  contentEntityOwners,
  knowledgePoints,
  knowledgePrerequisites,
  questionKnowledgePoints,
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
    contentBundles,
    contentBundleVersions,
    contentEntityOwners,
    knowledgePoints,
    knowledgePrerequisites,
    questionKnowledgePoints,
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

  it("accepts published content when source and knowledge-point link exist at commit", async () => {
    const [question] = await insertOwnedQuestion({ externalKey: `published-${randomUUID()}` });
    const [source] = await db.insert(sources).values({ label: `Source ${randomUUID()}` }).returning();
    const [point] = await insertOwnedKnowledgePoint({
      canonicalId: `published-point-${randomUUID()}`,
      name: "Published point",
      grade: 7,
      semester: 1
    });

    await db.transaction(async (tx) => {
      await tx.insert(questionVersions).values({
        questionId: question.id,
        version: 1,
        stem: "Complete published question",
        answer: "Yes",
        explanation: "It has both required references.",
        sourceId: source.id,
        reviewState: "published"
      });
      await tx.insert(questionKnowledgePoints).values({ questionId: question.id, knowledgePointId: point.id });
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
      await tx.insert(questionVersions).values({
        questionId: question.id,
        version: 1,
        stem: "Published with one link",
        answer: "Yes",
        explanation: "Removing the last link must fail.",
        sourceId: source.id,
        reviewState: "published"
      });
    });

    await expect(
      db.transaction((tx) => tx.delete(questionKnowledgePoints).where(and(
        eq(questionKnowledgePoints.questionId, question.id),
        eq(questionKnowledgePoints.knowledgePointId, point.id)
      )))
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
      await tx.insert(questionVersions).values({
        questionId: question.id,
        version: 1,
        stem: "Published before replacement",
        answer: "Yes",
        explanation: "Replacing links in one transaction is valid.",
        sourceId: source.id,
        reviewState: "published"
      });
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
  });
});
