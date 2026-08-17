import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { ContentBundleSchema, type Actor, type ContentBundle } from "@math/contracts";
import {
  auditEvents,
  contentBundleVersions,
  knowledgePointVersions,
  knowledgePoints,
  knowledgePrerequisites,
  questionKnowledgePoints,
  questionVersions,
  questions,
  sources
} from "@math/db";
import { and, count, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContentRepository } from "../src/modules/content/repository.js";
import { ContentService } from "../src/modules/content/service.js";

const schema = {
  auditEvents,
  contentBundleVersions,
  knowledgePointVersions,
  knowledgePoints,
  knowledgePrerequisites,
  questionKnowledgePoints,
  questionVersions,
  questions,
  sources
};

const operator: Actor = { userId: "operator-test", roles: ["operator"] };
const pglite = await PGlite.create({ extensions: { pgcrypto } });
const db = drizzle(pglite, { schema });
const repository = new ContentRepository();
const service = new ContentService(db, repository);

function createBundle(suffix = randomUUID()): ContentBundle {
  return ContentBundleSchema.parse({
    bundleId: `mock-g7-s1-${suffix}`,
    version: 1,
    knowledgePoints: [
      {
        canonicalId: `g7s1.rational.${suffix}`,
        name: "有理数",
        grade: 7,
        semester: 1,
        prerequisites: []
      },
      {
        canonicalId: `g7s1.operations.${suffix}`,
        name: "有理数运算",
        grade: 7,
        semester: 1,
        prerequisites: [`g7s1.rational.${suffix}`]
      }
    ],
    questions: [
      {
        externalKey: `mock-q-${suffix}`,
        stem: "计算：-2+5",
        answer: "3",
        explanation: "异号相加，取绝对值较大数的符号。",
        knowledgeCanonicalIds: [`g7s1.operations.${suffix}`],
        difficulty: 1,
        sourceLabel: `MVP simulated content ${suffix}`
      }
    ]
  });
}

beforeAll(async () => {
  for (const migrationName of ["0000_foundation.sql", "0001_content_import_tracking.sql"]) {
    const migrationPath = fileURLToPath(new URL(`../../../packages/db/migrations/${migrationName}`, import.meta.url));
    await pglite.exec(await readFile(migrationPath, "utf8"));
  }
});

afterAll(async () => {
  await pglite.close();
});

describe("ContentService.importBundle", () => {
  it("imports an identical bundle idempotently using a canonical payload hash", async () => {
    const bundle = createBundle();
    const reordered = {
      ...bundle,
      knowledgePoints: [...bundle.knowledgePoints].reverse()
    };

    const first = await service.importBundle(bundle, operator);
    const second = await service.importBundle(reordered, operator);

    expect(first).toEqual({ createdKnowledge: 2, createdQuestions: 1, newVersions: 0, unchanged: 0 });
    expect(second).toEqual({ createdKnowledge: 0, createdQuestions: 0, newVersions: 0, unchanged: 3 });

    const [bundleCount] = await db
      .select({ value: count() })
      .from(contentBundleVersions)
      .where(eq(contentBundleVersions.bundleId, bundle.bundleId));
    expect(bundleCount?.value).toBe(1);
  });

  it("rejects a changed payload under an already imported bundle version", async () => {
    const bundle = createBundle();
    await service.importBundle(bundle, operator);

    const mutated = {
      ...bundle,
      questions: [{ ...bundle.questions[0]!, answer: "4" }]
    };

    await expect(service.importBundle(mutated, operator)).rejects.toThrow(/different payload/i);

    const [versionCount] = await db
      .select({ value: count() })
      .from(questionVersions)
      .innerJoin(questions, eq(questionVersions.questionId, questions.id))
      .where(eq(questions.externalKey, bundle.questions[0]!.externalKey));
    expect(versionCount?.value).toBe(1);
  });

  it("rejects any bundle version below the latest imported version", async () => {
    const versionOne = createBundle();
    const versionTwo = {
      ...versionOne,
      version: 2,
      questions: [{ ...versionOne.questions[0]!, stem: "计算并说明：-2+5" }]
    };
    await service.importBundle(versionOne, operator);
    await service.importBundle(versionTwo, operator);

    await expect(service.importBundle(versionOne, operator)).rejects.toThrow(/lower than latest/i);
  });

  it("appends a draft version while retaining the stable question ID", async () => {
    const bundle = createBundle();
    await service.importBundle(bundle, operator);
    const [stableBefore] = await db
      .select()
      .from(questions)
      .where(eq(questions.externalKey, bundle.questions[0]!.externalKey));

    const changed = {
      ...bundle,
      version: 2,
      questions: [{ ...bundle.questions[0]!, stem: "计算并说明：-2+5" }]
    };
    const result = await service.importBundle(changed, operator);
    const [stableAfter] = await db
      .select()
      .from(questions)
      .where(eq(questions.externalKey, bundle.questions[0]!.externalKey));
    const versions = await db
      .select({ version: questionVersions.version, reviewState: questionVersions.reviewState })
      .from(questionVersions)
      .where(eq(questionVersions.questionId, stableAfter!.id));

    expect(result).toEqual({ createdKnowledge: 0, createdQuestions: 0, newVersions: 1, unchanged: 2 });
    expect(stableAfter!.id).toBe(stableBefore!.id);
    expect(versions).toEqual(expect.arrayContaining([
      { version: 1, reviewState: "draft" },
      { version: 2, reviewState: "draft" }
    ]));
  });

  it("replaces prerequisites and question links while recording changed versions", async () => {
    const bundle = createBundle();
    await service.importBundle(bundle, operator);
    const rationalId = bundle.knowledgePoints[0]!.canonicalId;
    const operationsId = bundle.knowledgePoints[1]!.canonicalId;

    const changed = {
      ...bundle,
      version: 2,
      knowledgePoints: [
        bundle.knowledgePoints[0]!,
        { ...bundle.knowledgePoints[1]!, prerequisites: [] }
      ],
      questions: [{ ...bundle.questions[0]!, knowledgeCanonicalIds: [rationalId] }]
    };
    const result = await service.importBundle(changed, operator);

    const stableKnowledge = await db
      .select({ id: knowledgePoints.id, canonicalId: knowledgePoints.canonicalId })
      .from(knowledgePoints)
      .where(inArray(knowledgePoints.canonicalId, [rationalId, operationsId]));
    const idByCanonicalId = new Map(stableKnowledge.map((row) => [row.canonicalId, row.id]));
    const prerequisiteRows = await db
      .select()
      .from(knowledgePrerequisites)
      .where(eq(knowledgePrerequisites.knowledgePointId, idByCanonicalId.get(operationsId)!));
    const [stableQuestion] = await db
      .select()
      .from(questions)
      .where(eq(questions.externalKey, bundle.questions[0]!.externalKey));
    const questionLinks = await db
      .select()
      .from(questionKnowledgePoints)
      .where(eq(questionKnowledgePoints.questionId, stableQuestion!.id));

    expect(result).toEqual({ createdKnowledge: 0, createdQuestions: 0, newVersions: 2, unchanged: 1 });
    expect(prerequisiteRows).toEqual([]);
    expect(questionLinks).toEqual([{
      questionId: stableQuestion!.id,
      knowledgePointId: idByCanonicalId.get(rationalId)
    }]);
  });

  it("upserts one source record for questions sharing a source label", async () => {
    const bundle = createBundle();
    const sourceLabel = bundle.questions[0]!.sourceLabel;
    const withSecondQuestion = {
      ...bundle,
      questions: [
        bundle.questions[0]!,
        {
          ...bundle.questions[0]!,
          externalKey: `${bundle.questions[0]!.externalKey}-second`,
          stem: "计算：5-2"
        }
      ]
    };

    await service.importBundle(withSecondQuestion, operator);

    const [sourceCount] = await db
      .select({ value: count() })
      .from(sources)
      .where(eq(sources.label, sourceLabel));
    expect(sourceCount?.value).toBe(1);
  });

  it("uses a supplied transaction so its caller can roll back every import write", async () => {
    const bundle = createBundle();

    await expect(db.transaction(async (transaction) => {
      await service.importBundle(bundle, operator, transaction);
      throw new Error("caller rollback");
    })).rejects.toThrow("caller rollback");

    const [stableCount] = await db
      .select({ value: count() })
      .from(questions)
      .where(eq(questions.externalKey, bundle.questions[0]!.externalKey));
    expect(stableCount?.value).toBe(0);
  });

  it("rolls back service-owned transaction writes after a database constraint failure", async () => {
    const bundle = createBundle();
    const invalid = {
      ...bundle,
      knowledgePoints: [
        { ...bundle.knowledgePoints[0]!, prerequisites: [bundle.knowledgePoints[0]!.canonicalId] },
        bundle.knowledgePoints[1]!
      ]
    };

    await expect(service.importBundle(invalid, operator)).rejects.toThrow();

    const [stableCount] = await db
      .select({ value: count() })
      .from(knowledgePoints)
      .where(inArray(knowledgePoints.canonicalId, invalid.knowledgePoints.map((point) => point.canonicalId)));
    const [trackingCount] = await db
      .select({ value: count() })
      .from(contentBundleVersions)
      .where(and(
        eq(contentBundleVersions.bundleId, invalid.bundleId),
        eq(contentBundleVersions.version, invalid.version)
      ));
    expect(stableCount?.value).toBe(0);
    expect(trackingCount?.value).toBe(0);
  });

  it("does not write audit events", async () => {
    const bundle = createBundle();
    await service.importBundle(bundle, operator);

    const [auditCount] = await db.select({ value: count() }).from(auditEvents);
    expect(auditCount?.value).toBe(0);
  });
});
