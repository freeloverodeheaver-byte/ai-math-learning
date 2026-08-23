import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { ContentBundleSchema, type Actor, type ContentBundle } from "@math/contracts";
import {
  auditEvents,
  contentBundles,
  contentBundleVersions,
  contentEntityOwners,
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
import {
  ContentRepository,
  type ContentTransaction,
  type SourceProvenanceInput,
} from "../src/modules/content/repository.js";
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

class RecordingContentRepository extends ContentRepository {
  readonly sourceLabels: string[] = [];

  override async upsertSource(
    transaction: ContentTransaction,
    input: SourceProvenanceInput,
  ): Promise<string> {
    this.sourceLabels.push(input.label);
    return super.upsertSource(transaction, input);
  }
}

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
        sourceLabel: `MVP simulated content ${suffix}`,
        sourceKind: "simulated",
        sourceReference: `fixture:${suffix}`,
        sourceUsageBasis: "synthetic test fixture"
      }
    ]
  });
}

function createCanonicalReplayBundle(suffix = randomUUID()): ContentBundle {
  const base = createBundle(suffix);
  const rationalId = base.knowledgePoints[0]!.canonicalId;
  const operationsId = base.knowledgePoints[1]!.canonicalId;
  return ContentBundleSchema.parse({
    ...base,
    knowledgePoints: [
      ...base.knowledgePoints,
      {
        canonicalId: `g7s1.expressions.${suffix}`,
        name: "整式",
        grade: 7,
        semester: 1,
        prerequisites: [rationalId, operationsId]
      }
    ],
    questions: [
      { ...base.questions[0]!, knowledgeCanonicalIds: [rationalId, operationsId] },
      {
        externalKey: `mock-q-${suffix}-second`,
        stem: "化简：3x+2x",
        answer: "5x",
        explanation: "合并同类项。",
        knowledgeCanonicalIds: [operationsId, `g7s1.expressions.${suffix}`],
        difficulty: 2,
        sourceLabel: base.questions[0]!.sourceLabel,
        sourceKind: base.questions[0]!.sourceKind,
        sourceReference: base.questions[0]!.sourceReference,
        sourceUsageBasis: base.questions[0]!.sourceUsageBasis
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
    const bundle = createCanonicalReplayBundle();
    const reordered: ContentBundle = {
      questions: [...bundle.questions].reverse().map((question) => ({
        sourceLabel: question.sourceLabel,
        sourceKind: question.sourceKind,
        sourceReference: question.sourceReference,
        sourceUsageBasis: question.sourceUsageBasis,
        difficulty: question.difficulty,
        knowledgeCanonicalIds: [...question.knowledgeCanonicalIds].reverse(),
        explanation: question.explanation,
        answer: question.answer,
        stem: question.stem,
        externalKey: question.externalKey
      })),
      knowledgePoints: [...bundle.knowledgePoints].reverse().map((point) => ({
        prerequisites: [...point.prerequisites].reverse(),
        semester: point.semester,
        grade: point.grade,
        name: point.name,
        canonicalId: point.canonicalId
      })),
      version: bundle.version,
      bundleId: bundle.bundleId
    };

    const first = await service.importBundle(bundle, operator);
    const second = await service.importBundle(reordered, operator);

    expect(first).toEqual({ createdKnowledge: 3, createdQuestions: 2, newVersions: 0, unchanged: 0 });
    expect(second).toEqual({ createdKnowledge: 0, createdQuestions: 0, newVersions: 0, unchanged: 5 });

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

  it.each([1, 2, 3])(
    "rejects cross-bundle ownership of shared knowledge and question keys at version %i without mutation",
    async (foreignVersion) => {
      const owned = { ...createBundle(), version: 2 };
      await service.importBundle(owned, operator);
      const ownedBundleId = owned.bundleId;
      const foreignBundleId = `${owned.bundleId}-foreign-${foreignVersion}`;
      const rationalId = owned.knowledgePoints[0]!.canonicalId;
      const operationsId = owned.knowledgePoints[1]!.canonicalId;
      const foreign = {
        ...owned,
        bundleId: foreignBundleId,
        version: foreignVersion,
        knowledgePoints: [
          { ...owned.knowledgePoints[0]!, name: "外部修改" },
          { ...owned.knowledgePoints[1]!, prerequisites: [] }
        ],
        questions: [{
          ...owned.questions[0]!,
          stem: "外部修改题目",
          knowledgeCanonicalIds: [rationalId],
          sourceLabel: `${owned.questions[0]!.sourceLabel}-foreign`
        }]
      };

      await expect(service.importBundle(foreign, operator))
        .rejects.toThrow(new RegExp(`owned by bundle ${ownedBundleId}`));

      const stableKnowledge = await db
        .select({ canonicalId: knowledgePoints.canonicalId, name: knowledgePoints.name })
        .from(knowledgePoints)
        .where(inArray(knowledgePoints.canonicalId, [rationalId, operationsId]));
      const [knowledgeVersionCount] = await db
        .select({ value: count() })
        .from(knowledgePointVersions)
        .innerJoin(knowledgePoints, eq(knowledgePointVersions.knowledgePointId, knowledgePoints.id))
        .where(inArray(knowledgePoints.canonicalId, [rationalId, operationsId]));
      const [stableQuestion] = await db
        .select()
        .from(questions)
        .where(eq(questions.externalKey, owned.questions[0]!.externalKey));
      const [questionVersionCount] = await db
        .select({ value: count() })
        .from(questionVersions)
        .where(eq(questionVersions.questionId, stableQuestion!.id));
      const questionLinks = await db
        .select({ canonicalId: knowledgePoints.canonicalId })
        .from(questionKnowledgePoints)
        .innerJoin(knowledgePoints, eq(questionKnowledgePoints.knowledgePointId, knowledgePoints.id))
        .where(eq(questionKnowledgePoints.questionId, stableQuestion!.id));
      const [foreignTrackingCount] = await db
        .select({ value: count() })
        .from(contentBundleVersions)
        .where(eq(contentBundleVersions.bundleId, foreignBundleId));
      const [foreignBundleCount] = await db
        .select({ value: count() })
        .from(contentBundles)
        .where(eq(contentBundles.bundleId, foreignBundleId));
      const owners = await db
        .select({ entityType: contentEntityOwners.entityType, entityKey: contentEntityOwners.entityKey })
        .from(contentEntityOwners)
        .where(eq(contentEntityOwners.bundleId, ownedBundleId));

      expect(stableKnowledge).toEqual(expect.arrayContaining([
        { canonicalId: rationalId, name: owned.knowledgePoints[0]!.name },
        { canonicalId: operationsId, name: owned.knowledgePoints[1]!.name }
      ]));
      expect(knowledgeVersionCount?.value).toBe(2);
      expect(questionVersionCount?.value).toBe(1);
      expect(questionLinks).toEqual([{ canonicalId: operationsId }]);
      expect(foreignTrackingCount?.value).toBe(0);
      expect(foreignBundleCount?.value).toBe(0);
      expect(owners).toHaveLength(3);
    }
  );

  it("rolls back fresh reservations when a later question-only ownership conflict is found", async () => {
    const owned = createBundle();
    await service.importBundle(owned, operator);
    const suffix = randomUUID();
    const foreignBundleId = `foreign-question-${suffix}`;
    const freshKnowledgeId = `fresh-knowledge-${suffix}`;
    const freshQuestionKey = `aaa-fresh-question-${suffix}`;
    const foreignSourceLabel = `Foreign source ${suffix}`;
    const foreign = ContentBundleSchema.parse({
      bundleId: foreignBundleId,
      version: 1,
      knowledgePoints: [{
        canonicalId: freshKnowledgeId,
        name: "Fresh knowledge",
        grade: 7,
        semester: 1,
        prerequisites: []
      }],
      questions: [
        {
          externalKey: freshQuestionKey,
          stem: "Fresh question",
          answer: "Fresh answer",
          explanation: "Fresh explanation",
          knowledgeCanonicalIds: [freshKnowledgeId],
          difficulty: 1,
          sourceLabel: foreignSourceLabel,
          sourceKind: "simulated",
          sourceReference: `fixture:${suffix}`,
          sourceUsageBasis: "synthetic test fixture"
        },
        {
          ...owned.questions[0]!,
          stem: "Foreign mutation",
          knowledgeCanonicalIds: [freshKnowledgeId],
          sourceLabel: foreignSourceLabel,
          sourceKind: "simulated",
          sourceReference: `fixture:${suffix}`,
          sourceUsageBasis: "synthetic test fixture"
        }
      ]
    });

    await expect(service.importBundle(foreign, operator))
      .rejects.toThrow(new RegExp(`question ${owned.questions[0]!.externalKey} is owned by bundle ${owned.bundleId}`));

    const tableCounts = await Promise.all([
      db.select({ value: count() }).from(contentBundles).where(eq(contentBundles.bundleId, foreignBundleId)),
      db.select({ value: count() }).from(contentBundleVersions).where(eq(contentBundleVersions.bundleId, foreignBundleId)),
      db.select({ value: count() }).from(contentEntityOwners).where(eq(contentEntityOwners.bundleId, foreignBundleId)),
      db.select({ value: count() }).from(sources).where(eq(sources.label, foreignSourceLabel)),
      db.select({ value: count() }).from(knowledgePoints).where(eq(knowledgePoints.canonicalId, freshKnowledgeId)),
      db.select({ value: count() }).from(knowledgePointVersions)
        .innerJoin(knowledgePoints, eq(knowledgePointVersions.knowledgePointId, knowledgePoints.id))
        .where(eq(knowledgePoints.canonicalId, freshKnowledgeId)),
      db.select({ value: count() }).from(knowledgePrerequisites)
        .innerJoin(knowledgePoints, eq(knowledgePrerequisites.knowledgePointId, knowledgePoints.id))
        .where(eq(knowledgePoints.canonicalId, freshKnowledgeId)),
      db.select({ value: count() }).from(questions).where(eq(questions.externalKey, freshQuestionKey)),
      db.select({ value: count() }).from(questionVersions)
        .innerJoin(questions, eq(questionVersions.questionId, questions.id))
        .where(eq(questions.externalKey, freshQuestionKey)),
      db.select({ value: count() }).from(questionKnowledgePoints)
        .innerJoin(questions, eq(questionKnowledgePoints.questionId, questions.id))
        .where(eq(questions.externalKey, freshQuestionKey))
    ]);
    expect(tableCounts.map(([row]) => row!.value)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    const [ownedQuestion] = await db.select().from(questions)
      .where(eq(questions.externalKey, owned.questions[0]!.externalKey));
    const [ownedQuestionVersionCount] = await db.select({ value: count() }).from(questionVersions)
      .where(eq(questionVersions.questionId, ownedQuestion!.id));
    const [ownedQuestionLinkCount] = await db.select({ value: count() }).from(questionKnowledgePoints)
      .where(eq(questionKnowledgePoints.questionId, ownedQuestion!.id));
    expect(ownedQuestionVersionCount!.value).toBe(1);
    expect(ownedQuestionLinkCount!.value).toBe(1);
  });

  it("smoke-checks identical overlapping outcomes under PGlite's serialized transaction callbacks", async () => {
    const bundle = createBundle();

    const results = await Promise.all([
      service.importBundle(bundle, operator),
      service.importBundle(bundle, operator)
    ]);

    expect(results).toEqual(expect.arrayContaining([
      { createdKnowledge: 2, createdQuestions: 1, newVersions: 0, unchanged: 0 },
      { createdKnowledge: 0, createdQuestions: 0, newVersions: 0, unchanged: 3 }
    ]));
    const [trackingCount] = await db
      .select({ value: count() })
      .from(contentBundleVersions)
      .where(eq(contentBundleVersions.bundleId, bundle.bundleId));
    expect(trackingCount?.value).toBe(1);
  });

  it("smoke-checks N and N+1 outcomes under PGlite with N+1 as the final current state", async () => {
    const versionOne = createBundle();
    await service.importBundle(versionOne, operator);
    const versionTwo = {
      ...versionOne,
      version: 2,
      questions: [{ ...versionOne.questions[0]!, stem: "并发版本 2" }]
    };
    const versionThree = {
      ...versionOne,
      version: 3,
      questions: [{ ...versionOne.questions[0]!, stem: "并发版本 3" }]
    };

    const outcomes = await Promise.allSettled([
      service.importBundle(versionTwo, operator),
      service.importBundle(versionThree, operator)
    ]);
    expect(outcomes[1]!.status).toBe("fulfilled");
    if (outcomes[0]!.status === "rejected") {
      expect(String(outcomes[0]!.reason)).toMatch(/lower than latest/i);
    }

    const [stableQuestion] = await db
      .select()
      .from(questions)
      .where(eq(questions.externalKey, versionOne.questions[0]!.externalKey));
    const versions = await db
      .select({ version: questionVersions.version, stem: questionVersions.stem })
      .from(questionVersions)
      .where(eq(questionVersions.questionId, stableQuestion!.id));

    expect(versions).toEqual(expect.arrayContaining([
      { version: 1, stem: versionOne.questions[0]!.stem },
      { version: 3, stem: "并发版本 3" }
    ]));
    if (outcomes[0]!.status === "fulfilled") {
      expect(versions).toContainEqual({ version: 2, stem: "并发版本 2" });
    }
    expect(versions.find((row) => row.version === 3)?.stem).toBe("并发版本 3");
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

  it("persists explicit source provenance", async () => {
    const bundle = createBundle();

    await service.importBundle(bundle, operator);

    const [source] = await db.select({
      reference: sources.reference,
      metadata: sources.metadata,
    }).from(sources).where(eq(sources.label, bundle.questions[0]!.sourceLabel));
    expect(source).toEqual({
      reference: bundle.questions[0]!.sourceReference,
      metadata: {
        kind: bundle.questions[0]!.sourceKind,
        usageBasis: bundle.questions[0]!.sourceUsageBasis,
      },
    });
  });

  it("rejects conflicting provenance for an existing source label without import writes", async () => {
    const bundle = createBundle();
    await db.insert(sources).values({
      label: bundle.questions[0]!.sourceLabel,
      reference: "existing-reference",
      metadata: { kind: "licensed", usageBasis: "existing license" },
    });

    await expect(service.importBundle(bundle, operator)).rejects.toThrow(/source provenance conflict/i);
    expect(await db.select().from(contentBundles)
      .where(eq(contentBundles.bundleId, bundle.bundleId))).toEqual([]);
    expect(await db.select().from(questions)
      .where(eq(questions.externalKey, bundle.questions[0]!.externalKey))).toEqual([]);
  });

  it("revalidates source provenance on an idempotent bundle replay", async () => {
    const bundle = createBundle();
    await service.importBundle(bundle, operator);
    await db.update(sources)
      .set({ reference: "externally-mutated-reference" })
      .where(eq(sources.label, bundle.questions[0]!.sourceLabel));

    await expect(service.importBundle(bundle, operator))
      .rejects.toThrow(/source provenance conflict/i);
  });

  it("includes source provenance in the canonical bundle hash", async () => {
    const bundle = createBundle();
    await service.importBundle(bundle, operator);
    const changedProvenance = ContentBundleSchema.parse({
      ...bundle,
      questions: [{
        ...bundle.questions[0]!,
        sourceReference: `${bundle.questions[0]!.sourceReference}-changed`,
      }],
    });

    await expect(service.importBundle(changedProvenance, operator))
      .rejects.toThrow(/different payload/i);
  });

  it("upserts distinct source labels once in deterministic global order", async () => {
    const bundle = createBundle();
    const recordingRepository = new RecordingContentRepository();
    const recordingService = new ContentService(db, recordingRepository);
    const sourceX = `Source X ${randomUUID()}`;
    const sourceY = `Source Y ${randomUUID()}`;
    const questionsInCallerOrder = [sourceY, sourceX, sourceY].map((sourceLabel, index) => ({
      ...bundle.questions[0]!,
      externalKey: `${bundle.questions[0]!.externalKey}-${index}`,
      sourceLabel
    }));

    await recordingService.importBundle({ ...bundle, questions: questionsInCallerOrder }, operator);

    expect(recordingRepository.sourceLabels).toEqual([sourceX, sourceY]);
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
