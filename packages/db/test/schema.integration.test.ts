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
  sources
} from "../src/schema";
import { applyJournaledMigrations } from "./migration-test-utils.js";

const testId = randomUUID();
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
    sources
  }
});

beforeAll(async () => {
  await applyJournaledMigrations(pglite, new URL("../migrations/", import.meta.url));
});

afterAll(async () => {
  await pglite.close();
});

describe("foundation schema", () => {
  it("keeps a stable question id while content versions change", async () => {
    const [question] = await db
      .insert(questions)
      .values({ externalKey: `mock-q-${testId}` })
      .returning();

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
    const [point] = await db
      .insert(knowledgePoints)
      .values({
        canonicalId: `g7.valid.${testId}`,
        name: "Valid",
        grade: 7,
        semester: 1
      })
      .returning();

    await expect(
      db.insert(knowledgePrerequisites).values({
        knowledgePointId: point.id,
        prerequisiteKnowledgePointId: randomUUID()
      })
    ).rejects.toThrow();
  });

  it("rejects a knowledge point outside the supported junior-middle-school grades", async () => {
    await expect(
      db.insert(knowledgePoints).values({
        canonicalId: `invalid-grade-${randomUUID()}`,
        name: "Invalid",
        grade: 6,
        semester: 1
      })
    ).rejects.toThrow();
  });

  it("rejects a published question version without a source", async () => {
    const [question] = await db.insert(questions).values({ externalKey: `missing-source-${randomUUID()}` }).returning();

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
    const [question] = await db.insert(questions).values({ externalKey: `missing-link-${randomUUID()}` }).returning();
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
    const [question] = await db.insert(questions).values({ externalKey: `published-${randomUUID()}` }).returning();
    const [source] = await db.insert(sources).values({ label: `Source ${randomUUID()}` }).returning();
    const [point] = await db.insert(knowledgePoints).values({
      canonicalId: `published-point-${randomUUID()}`,
      name: "Published point",
      grade: 7,
      semester: 1
    }).returning();

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
    const [question] = await db.insert(questions).values({ externalKey: `final-link-${randomUUID()}` }).returning();
    const [source] = await db.insert(sources).values({ label: `Source ${randomUUID()}` }).returning();
    const [point] = await db.insert(knowledgePoints).values({
      canonicalId: `final-link-point-${randomUUID()}`,
      name: "Final link point",
      grade: 7,
      semester: 1
    }).returning();

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
    const [question] = await db.insert(questions).values({ externalKey: `replace-link-${randomUUID()}` }).returning();
    const [source] = await db.insert(sources).values({ label: `Source ${randomUUID()}` }).returning();
    const [firstPoint] = await db.insert(knowledgePoints).values({
      canonicalId: `replace-first-${randomUUID()}`,
      name: "First point",
      grade: 7,
      semester: 1
    }).returning();
    const [secondPoint] = await db.insert(knowledgePoints).values({
      canonicalId: `replace-second-${randomUUID()}`,
      name: "Second point",
      grade: 7,
      semester: 1
    }).returning();

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
  });
});
