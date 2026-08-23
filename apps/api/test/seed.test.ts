import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { ContentBundleSchema } from "@math/contracts";
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
  sources,
} from "@math/db";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { resolveBundlePath, seedContentBundle } from "../src/modules/content/seed.js";

describe("resolveBundlePath", () => {
  it("ships a version-two seed with explicit non-AI provenance", async () => {
    const seedUrl = new URL("../../../seed/mock-content-grade-7-semester-1.json", import.meta.url);
    const bundle = ContentBundleSchema.parse(JSON.parse(await readFile(seedUrl, "utf8")));

    expect(bundle.version).toBe(2);
    expect(bundle.questions.every((question) =>
      question.sourceKind === "simulated" &&
      question.sourceReference.length > 0 &&
      question.sourceUsageBasis.length > 0
    )).toBe(true);
  });

  it("accepts the pnpm argument separator before the bundle path", () => {
    expect(resolveBundlePath(["--", "../../seed/mock-content.json"]))
      .toBe("../../seed/mock-content.json");
  });

  it("rejects a missing bundle path", () => {
    expect(() => resolveBundlePath(["--"])).toThrow("A content bundle JSON path is required");
  });

  it("publishes and audits every system seed invocation without duplicating content on replay", async () => {
    const pglite = await PGlite.create({ extensions: { pgcrypto } });
    try {
      const migrations = new URL("../../../packages/db/migrations/", import.meta.url);
      const journal = JSON.parse(
        await readFile(new URL("meta/_journal.json", migrations), "utf8"),
      ) as { entries: Array<{ tag: string }> };
      for (const entry of journal.entries) {
        await pglite.exec(await readFile(new URL(`${entry.tag}.sql`, migrations), "utf8"));
      }
      const database = drizzle(pglite, {
        schema: {
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
          sources,
        },
      });
      const seedUrl = new URL("../../../seed/mock-content-grade-7-semester-1.json", import.meta.url);
      const bundle = ContentBundleSchema.parse(JSON.parse(await readFile(seedUrl, "utf8")));

      const first = await seedContentBundle(database, bundle);
      const replay = await seedContentBundle(database, bundle);

      expect(first).toEqual({
        createdKnowledge: 3,
        createdQuestions: 2,
        newVersions: 0,
        unchanged: 0,
      });
      expect(replay).toEqual({
        createdKnowledge: 0,
        createdQuestions: 0,
        newVersions: 0,
        unchanged: 5,
      });
      const [knowledgeVersionCount] = await database.select({ value: count() })
        .from(knowledgePointVersions);
      const [questionVersionCount] = await database.select({ value: count() })
        .from(questionVersions);
      expect(knowledgeVersionCount!.value).toBe(3);
      expect(questionVersionCount!.value).toBe(2);
      expect(await database.select({ state: questionVersions.reviewState })
        .from(questionVersions)).toEqual([
        { state: "published" },
        { state: "published" },
      ]);
      const audits = await database.select({
        actorUserId: auditEvents.actorUserId,
        action: auditEvents.action,
        subjectId: auditEvents.subjectId,
        metadata: auditEvents.metadata,
      }).from(auditEvents).where(eq(auditEvents.subjectId, bundle.bundleId));
      expect(audits).toHaveLength(4);
      expect(audits).toEqual(expect.arrayContaining([
        expect.objectContaining({
          actorUserId: null,
          action: "content.bundle.imported",
          subjectId: bundle.bundleId,
          metadata: expect.objectContaining({ initiator: "system_seed" }),
        }),
        expect.objectContaining({
          actorUserId: null,
          action: "content.bundle.published",
          subjectId: bundle.bundleId,
          metadata: expect.objectContaining({ initiator: "system_seed" }),
        }),
      ]));
    } finally {
      await pglite.close();
    }
  });
});
