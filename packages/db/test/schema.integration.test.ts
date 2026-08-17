import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import {
  knowledgePoints,
  knowledgePrerequisites,
  questionKnowledgePoints,
  questionVersions,
  questions,
  sources
} from "../src/schema";

const testId = randomUUID();
const pglite = await PGlite.create({ extensions: { pgcrypto } });
const db = drizzle(pglite, {
  schema: { knowledgePoints, knowledgePrerequisites, questionKnowledgePoints, questionVersions, questions, sources }
});

beforeAll(async () => {
  const migration = await readFile(fileURLToPath(new URL("../migrations/0000_foundation.sql", import.meta.url)), "utf8");
  await pglite.exec(migration);
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
    const [source] = await db.insert(sources).values({ label: "Source" }).returning();

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
    const [source] = await db.insert(sources).values({ label: "Source" }).returning();
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

  it("declares the named anti-self prerequisite check", () => {
    expect(getTableConfig(knowledgePrerequisites).checks.map((constraint) => constraint.name))
      .toContain("knowledge_prerequisites_not_self");
  });
});
