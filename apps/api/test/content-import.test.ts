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
        sourceLabel: base.questions[0]!.sourceLabel
      }
    ]
  });
}

beforeAll(async () => {
  for (const migrationName of ["0000_foundation.sql", "0001_content_import_tracking.sql"]) {
    const migrationPath = fileURLToPath(new URL(`../../../packages/db/migrations/${migrationName}`, import.meta.url));
    await pglite.exec(await readFile(migrationPath, "utf8"));
  }
  await pglite.exec(`
    CREATE FUNCTION enforce_knowledge_import_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE owner_bundle_id text;
    BEGIN
      SELECT bundle_id INTO owner_bundle_id
      FROM content_entity_owners
      WHERE entity_type = 'knowledge' AND entity_key = NEW.canonical_id;

      IF owner_bundle_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM content_bundle_versions WHERE bundle_id = owner_bundle_id
      ) THEN
        RAISE EXCEPTION 'knowledge owner and bundle version must be reserved before stable insert';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER knowledge_import_reservation
    BEFORE INSERT ON knowledge_points
    FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_import_reservation();

    CREATE FUNCTION enforce_question_import_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE owner_bundle_id text;
    BEGIN
      SELECT bundle_id INTO owner_bundle_id
      FROM content_entity_owners
      WHERE entity_type = 'question' AND entity_key = NEW.external_key;

      IF owner_bundle_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM content_bundle_versions WHERE bundle_id = owner_bundle_id
      ) THEN
        RAISE EXCEPTION 'question owner and bundle version must be reserved before stable insert';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER question_import_reservation
    BEFORE INSERT ON questions
    FOR EACH ROW EXECUTE FUNCTION enforce_question_import_reservation();
  `);
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

  it("serializes concurrent identical first imports into created and idempotent results", async () => {
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

  it("serializes concurrent N and N+1 imports with N+1 as the final current state", async () => {
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

    await expect(Promise.all([
      service.importBundle(versionTwo, operator),
      service.importBundle(versionThree, operator)
    ])).resolves.toHaveLength(2);

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
      { version: 2, stem: "并发版本 2" },
      { version: 3, stem: "并发版本 3" }
    ]));
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
