import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { ContentBundleSchema, type Actor } from "@math/contracts";
import {
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
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { ContentRepository } from "../src/modules/content/repository.js";
import { ContentService } from "../src/modules/content/service.js";

const LEGACY_BUNDLE_ID = "__legacy_pre_import__";
const operator: Actor = { userId: "upgrade-test", roles: ["operator"] };

async function migration(name: string): Promise<string> {
  const path = fileURLToPath(new URL(`../../../packages/db/migrations/${name}`, import.meta.url));
  return readFile(path, "utf8");
}

describe("0000 to 0001 content ownership upgrade", () => {
  it("merges duplicate sources, backfills legacy owners, and rejects a normal bundle overlap atomically", async () => {
    const pglite = await PGlite.create({ extensions: { pgcrypto } });
    const db = drizzle(pglite, {
      schema: {
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
      }
    });

    try {
      await pglite.exec(await migration("0000_foundation.sql"));
      const suffix = randomUUID();
      const sourceLabel = `Legacy duplicate source ${suffix}`;
      const [survivorSource] = await db.insert(sources).values({
        label: sourceLabel,
        createdAt: new Date("2020-01-01T00:00:00.000Z")
      }).returning();
      const [duplicateSource] = await db.insert(sources).values({
        label: sourceLabel,
        createdAt: new Date("2021-01-01T00:00:00.000Z")
      }).returning();
      const [prerequisite] = await db.insert(knowledgePoints).values({
        canonicalId: `legacy-prerequisite-${suffix}`,
        name: "Legacy prerequisite",
        grade: 7,
        semester: 1
      }).returning();
      const [point] = await db.insert(knowledgePoints).values({
        canonicalId: `legacy-point-${suffix}`,
        name: "Legacy point",
        grade: 7,
        semester: 1
      }).returning();
      await db.insert(knowledgePointVersions).values([
        {
          knowledgePointId: prerequisite!.id,
          version: 2,
          name: prerequisite!.name,
          grade: 7,
          semester: 1,
          reviewState: "draft"
        },
        {
          knowledgePointId: point!.id,
          version: 2,
          name: point!.name,
          grade: 7,
          semester: 1,
          reviewState: "draft"
        }
      ]);
      await db.insert(knowledgePrerequisites).values({
        knowledgePointId: point!.id,
        prerequisiteKnowledgePointId: prerequisite!.id
      });
      const [question] = await db.insert(questions).values({
        externalKey: `legacy-question-${suffix}`
      }).returning();
      const [legacyQuestionVersion] = await db.insert(questionVersions).values({
        questionId: question!.id,
        version: 2,
        stem: "Legacy stem",
        answer: "Legacy answer",
        explanation: "Legacy explanation",
        difficulty: 2,
        sourceId: duplicateSource!.id,
        reviewState: "draft"
      }).returning();
      await db.insert(questionKnowledgePoints).values({
        questionId: question!.id,
        knowledgePointId: point!.id
      });

      await pglite.exec(await migration("0001_content_import_tracking.sql"));

      const mergedSources = await db.select().from(sources).where(eq(sources.label, sourceLabel));
      expect(mergedSources).toHaveLength(1);
      expect(mergedSources[0]!.id).toBe(survivorSource!.id);
      const [preservedVersion] = await db.select().from(questionVersions)
        .where(eq(questionVersions.id, legacyQuestionVersion!.id));
      expect(preservedVersion!.sourceId).toBe(survivorSource!.id);

      const legacyBundles = await db.select().from(contentBundles);
      expect(legacyBundles.map((row) => row.bundleId)).toEqual([LEGACY_BUNDLE_ID]);
      const legacyOwners = await db.select({
        entityType: contentEntityOwners.entityType,
        entityKey: contentEntityOwners.entityKey,
        bundleId: contentEntityOwners.bundleId
      }).from(contentEntityOwners);
      expect(legacyOwners).toEqual(expect.arrayContaining([
        { entityType: "knowledge", entityKey: prerequisite!.canonicalId, bundleId: LEGACY_BUNDLE_ID },
        { entityType: "knowledge", entityKey: point!.canonicalId, bundleId: LEGACY_BUNDLE_ID },
        { entityType: "question", entityKey: question!.externalKey, bundleId: LEGACY_BUNDLE_ID }
      ]));
      expect(legacyOwners).toHaveLength(3);

      const triggerNames = await pglite.query<{ tgname: string }>(`
        SELECT tgname FROM pg_trigger
        WHERE tgname IN ('knowledge_points_owner_integrity', 'questions_owner_integrity')
        ORDER BY tgname
      `);
      expect(triggerNames.rows.map((row) => row.tgname)).toEqual([
        "knowledge_points_owner_integrity",
        "questions_owner_integrity"
      ]);
      await expect(db.insert(knowledgePoints).values({
        canonicalId: `ownerless-${suffix}`,
        name: "Ownerless",
        grade: 7,
        semester: 1
      })).rejects.toThrow(/owner/i);

      const before = {
        bundle: (await db.select({ value: count() }).from(contentBundles))[0]!.value,
        tracking: (await db.select({ value: count() }).from(contentBundleVersions))[0]!.value,
        owner: (await db.select({ value: count() }).from(contentEntityOwners))[0]!.value,
        source: (await db.select({ value: count() }).from(sources))[0]!.value,
        knowledge: (await db.select({ value: count() }).from(knowledgePoints))[0]!.value,
        knowledgeVersion: (await db.select({ value: count() }).from(knowledgePointVersions))[0]!.value,
        prerequisite: (await db.select({ value: count() }).from(knowledgePrerequisites))[0]!.value,
        question: (await db.select({ value: count() }).from(questions))[0]!.value,
        questionVersion: (await db.select({ value: count() }).from(questionVersions))[0]!.value,
        questionLink: (await db.select({ value: count() }).from(questionKnowledgePoints))[0]!.value
      };
      const overlappingBundle = ContentBundleSchema.parse({
        bundleId: `normal-import-${suffix}`,
        version: 1,
        knowledgePoints: [
          {
            canonicalId: prerequisite!.canonicalId,
            name: "Attempted mutation",
            grade: 7,
            semester: 1,
            prerequisites: []
          },
          {
            canonicalId: point!.canonicalId,
            name: "Attempted mutation",
            grade: 7,
            semester: 1,
            prerequisites: [prerequisite!.canonicalId]
          }
        ],
        questions: [{
          externalKey: question!.externalKey,
          stem: "Attempted mutation",
          answer: "Attempted mutation",
          explanation: "Attempted mutation",
          knowledgeCanonicalIds: [point!.canonicalId],
          difficulty: 2,
          sourceLabel: `Foreign ${sourceLabel}`
        }]
      });

      const service = new ContentService(db, new ContentRepository());
      await expect(service.importBundle(overlappingBundle, operator))
        .rejects.toThrow(new RegExp(`owned by bundle ${LEGACY_BUNDLE_ID}`));

      const after = {
        bundle: (await db.select({ value: count() }).from(contentBundles))[0]!.value,
        tracking: (await db.select({ value: count() }).from(contentBundleVersions))[0]!.value,
        owner: (await db.select({ value: count() }).from(contentEntityOwners))[0]!.value,
        source: (await db.select({ value: count() }).from(sources))[0]!.value,
        knowledge: (await db.select({ value: count() }).from(knowledgePoints))[0]!.value,
        knowledgeVersion: (await db.select({ value: count() }).from(knowledgePointVersions))[0]!.value,
        prerequisite: (await db.select({ value: count() }).from(knowledgePrerequisites))[0]!.value,
        question: (await db.select({ value: count() }).from(questions))[0]!.value,
        questionVersion: (await db.select({ value: count() }).from(questionVersions))[0]!.value,
        questionLink: (await db.select({ value: count() }).from(questionKnowledgePoints))[0]!.value
      };
      expect(after).toEqual(before);
    } finally {
      await pglite.close();
    }
  });
});
