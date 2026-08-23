import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { Actor, ContentBundle } from "@math/contracts";
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
  users,
} from "@math/db";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { databaseRouteOptions } from "../src/composition.js";
import { AuditRepository } from "../src/modules/audit/repository.js";
import { AuditService, type AuditEventInput } from "../src/modules/audit/service.js";
import { ContentRepository, type ContentTransaction } from "../src/modules/content/repository.js";
import type { ContentRoutesOptions } from "../src/modules/content/routes.js";
import { ContentService, type ImportResult } from "../src/modules/content/service.js";
import { DevIdentityProvider } from "../src/modules/identity/dev-identity-provider.js";

const bundle: ContentBundle = {
  bundleId: "operator-api-bundle",
  version: 1,
  knowledgePoints: [{
    canonicalId: "g7s1.rational",
    name: "有理数",
    grade: 7,
    semester: 1,
    prerequisites: [],
  }],
  questions: [{
    externalKey: "operator-api-q1",
    stem: "计算：-2+5",
    answer: "3",
    explanation: "异号相加。",
    knowledgeCanonicalIds: ["g7s1.rational"],
    difficulty: 1,
    sourceLabel: "Operator API fixture",
  }],
};

const operatorUserId = randomUUID();
const operatorHeaders = {
  "x-dev-user-id": operatorUserId,
  "x-dev-roles": "operator",
};

const pglite = await PGlite.create({ extensions: { pgcrypto } });
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
    users,
  },
});
const contentRepository = new ContentRepository();
const contentService = new ContentService(database, contentRepository);
const auditService = new AuditService(new AuditRepository());

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

function createUniqueBundle(prefix: string, version = 1): ContentBundle {
  const suffix = randomUUID();
  const canonicalId = `${prefix}-point-${suffix}`;
  return {
    ...bundle,
    bundleId: `${prefix}-${suffix}`,
    version,
    knowledgePoints: [{ ...bundle.knowledgePoints[0], canonicalId }],
    questions: [{
      ...bundle.questions[0],
      externalKey: `${prefix}-question-${suffix}`,
      knowledgeCanonicalIds: [canonicalId],
    }],
  };
}

beforeAll(async () => {
  const migrationsUrl = new URL("../../../packages/db/migrations/", import.meta.url);
  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", migrationsUrl), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  for (const entry of journal.entries) {
    await pglite.exec(await readFile(new URL(`${entry.tag}.sql`, migrationsUrl), "utf8"));
  }
  await database.insert(users).values({
    id: operatorUserId,
    externalSubject: `operator-${operatorUserId}`,
  });
});

afterAll(async () => {
  await pglite.close();
});

async function buildIdentityApp() {
  const app = await buildApp({
    actorPlugin: {
      provider: new DevIdentityProvider(),
      nodeEnv: "test",
      devIdentityEnabled: true,
    },
  });
  apps.push(app);
  return app;
}

async function buildDatabaseApp() {
  const app = await buildApp({
    actorPlugin: {
      provider: new DevIdentityProvider(),
      nodeEnv: "test",
      devIdentityEnabled: true,
    },
    contentRoutes: {
      database,
      contentService,
      contentRepository,
      auditService,
    },
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("operator content API", () => {
  it("validates a complete bundle without requiring persistence dependencies", async () => {
    const app = await buildIdentityApp();

    const response = await app.inject({
      method: "POST",
      url: "/operator/content/bundles/validate",
      headers: operatorHeaders,
      payload: bundle,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ valid: true, knowledgePoints: 1, questions: 1 });
  });

  it("requires authentication before validating a bundle", async () => {
    const app = await buildIdentityApp();

    const response = await app.inject({
      method: "POST",
      url: "/operator/content/bundles/validate",
      payload: bundle,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("requires the operator role before validating a bundle", async () => {
    const app = await buildIdentityApp();

    const response = await app.inject({
      method: "POST",
      url: "/operator/content/bundles/validate",
      headers: { "x-dev-user-id": "teacher-1", "x-dev-roles": "teacher" },
      payload: bundle,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns structured 422 issues containing an unknown canonical ID", async () => {
    const app = await buildIdentityApp();
    const unknownCanonicalId = "g7s1.unknown";

    const response = await app.inject({
      method: "POST",
      url: "/operator/content/bundles/validate",
      headers: operatorHeaders,
      payload: {
        ...bundle,
        questions: [{
          ...bundle.questions[0],
          knowledgeCanonicalIds: [unknownCanonicalId],
        }],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      code: "INVALID_CONTENT_BUNDLE",
      issues: [{
        path: ["questions", 0, "knowledgeCanonicalIds"],
        code: "custom",
        message: `Unknown knowledge point: ${unknownCanonicalId}`,
      }],
    });
  });

  it("requires authentication and the operator role before importing", async () => {
    const app = await buildIdentityApp();
    const unauthenticated = await app.inject({
      method: "POST",
      url: "/operator/content/bundles/import",
      payload: bundle,
    });
    const teacher = await app.inject({
      method: "POST",
      url: "/operator/content/bundles/import",
      headers: { "x-dev-user-id": "teacher-1", "x-dev-roles": "teacher" },
      payload: bundle,
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({ code: "UNAUTHORIZED" });
    expect(teacher.statusCode).toBe(403);
    expect(teacher.json()).toEqual({ code: "FORBIDDEN" });
  });

  it("imports, publishes the exact revision, and records both audit events with the actor", async () => {
    const app = await buildDatabaseApp();
    const importedBundle: ContentBundle = {
      ...bundle,
      bundleId: `successful-import-${randomUUID()}`,
      knowledgePoints: [{
        ...bundle.knowledgePoints[0],
        canonicalId: `successful-point-${randomUUID()}`,
      }],
      questions: [{
        ...bundle.questions[0],
        externalKey: `successful-question-${randomUUID()}`,
        knowledgeCanonicalIds: [],
      }],
    };
    importedBundle.questions[0]!.knowledgeCanonicalIds = [
      importedBundle.knowledgePoints[0]!.canonicalId,
    ];

    const response = await app.inject({
      method: "POST",
      url: "/operator/content/bundles/import",
      headers: operatorHeaders,
      payload: importedBundle,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      bundleId: importedBundle.bundleId,
      version: 1,
      result: { createdKnowledge: 1, createdQuestions: 1, newVersions: 0, unchanged: 0 },
    });

    const knowledgeRows = await database.select({ reviewState: knowledgePointVersions.reviewState })
      .from(knowledgePointVersions)
      .innerJoin(knowledgePoints, eq(knowledgePointVersions.knowledgePointId, knowledgePoints.id))
      .where(eq(knowledgePoints.canonicalId, importedBundle.knowledgePoints[0]!.canonicalId));
    const questionRows = await database.select({ reviewState: questionVersions.reviewState })
      .from(questionVersions)
      .innerJoin(questions, eq(questionVersions.questionId, questions.id))
      .where(eq(questions.externalKey, importedBundle.questions[0]!.externalKey));
    expect(knowledgeRows).toEqual([{ reviewState: "published" }]);
    expect(questionRows).toEqual([{ reviewState: "published" }]);

    const audits = await database.select({
      actorUserId: auditEvents.actorUserId,
      action: auditEvents.action,
      subjectId: auditEvents.subjectId,
      metadata: auditEvents.metadata,
    }).from(auditEvents).where(eq(auditEvents.subjectId, importedBundle.bundleId));
    expect(audits).toEqual(expect.arrayContaining([
      {
        actorUserId: operatorUserId,
        action: "content.bundle.imported",
        subjectId: importedBundle.bundleId,
        metadata: {
          bundleId: importedBundle.bundleId,
          version: 1,
          result: { createdKnowledge: 1, createdQuestions: 1, newVersions: 0, unchanged: 0 },
        },
      },
      {
        actorUserId: operatorUserId,
        action: "content.bundle.published",
        subjectId: importedBundle.bundleId,
        metadata: { bundleId: importedBundle.bundleId, version: 1 },
      },
    ]));
  });

  it("returns a typed 409 for a lower-than-latest bundle version without leaking database details", async () => {
    const app = await buildDatabaseApp();
    const suffix = randomUUID();
    const latest: ContentBundle = {
      ...bundle,
      bundleId: `regression-${suffix}`,
      version: 2,
      knowledgePoints: [{
        ...bundle.knowledgePoints[0],
        canonicalId: `regression-point-${suffix}`,
      }],
      questions: [{
        ...bundle.questions[0],
        externalKey: `regression-question-${suffix}`,
        knowledgeCanonicalIds: [`regression-point-${suffix}`],
      }],
    };
    const first = await app.inject({
      method: "POST",
      url: "/operator/content/bundles/import",
      headers: operatorHeaders,
      payload: latest,
    });
    expect(first.statusCode).toBe(201);

    const response = await app.inject({
      method: "POST",
      url: "/operator/content/bundles/import",
      headers: operatorHeaders,
      payload: { ...latest, version: 1 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "CONTENT_VERSION_REGRESSION" });
    expect(response.body).not.toMatch(/constraint|duplicate|sql/i);
  });

  it("does not persist content or audit state when validation succeeds or import parsing fails", async () => {
    const app = await buildDatabaseApp();
    const validationBundle = createUniqueBundle("validation-only");
    const validation = await app.inject({
      method: "POST",
      url: "/operator/content/bundles/validate",
      headers: operatorHeaders,
      payload: validationBundle,
    });
    const invalidImport = await app.inject({
      method: "POST",
      url: "/operator/content/bundles/import",
      headers: operatorHeaders,
      payload: {
        ...validationBundle,
        questions: [{
          ...validationBundle.questions[0],
          knowledgeCanonicalIds: ["unknown-before-persistence"],
        }],
      },
    });

    expect(validation.statusCode).toBe(200);
    expect(invalidImport.statusCode).toBe(422);
    const [bundleRows, auditRows] = await Promise.all([
      database.select().from(contentBundles).where(eq(contentBundles.bundleId, validationBundle.bundleId)),
      database.select().from(auditEvents).where(eq(auditEvents.subjectId, validationBundle.bundleId)),
    ]);
    const [knowledgeRows, questionRows] = await Promise.all([
      database.select().from(knowledgePoints).where(eq(
        knowledgePoints.canonicalId,
        validationBundle.knowledgePoints[0]!.canonicalId,
      )),
      database.select().from(questions).where(eq(
        questions.externalKey,
        validationBundle.questions[0]!.externalKey,
      )),
    ]);
    expect(bundleRows).toEqual([]);
    expect(auditRows).toEqual([]);
    expect(knowledgeRows).toEqual([]);
    expect(questionRows).toEqual([]);
  });

  it("keeps another bundle's same-numbered revision draft", async () => {
    const foreign = createUniqueBundle("foreign-revision", 2);
    const actor: Actor = { userId: operatorUserId, roles: ["operator"] };
    await contentService.importBundle(foreign, actor);
    const target = createUniqueBundle("exact-revision", 2);
    const app = await buildDatabaseApp();

    const response = await app.inject({
      method: "POST",
      url: "/operator/content/bundles/import",
      headers: operatorHeaders,
      payload: target,
    });

    expect(response.statusCode).toBe(201);
    const foreignStates = await database.select({ reviewState: questionVersions.reviewState })
      .from(questionVersions)
      .innerJoin(questions, eq(questionVersions.questionId, questions.id))
      .where(eq(questions.externalKey, foreign.questions[0]!.externalKey));
    expect(foreignStates).toEqual([{ reviewState: "draft" }]);
  });

  it("replays an identical request idempotently while auditing every request", async () => {
    const replay = createUniqueBundle("idempotent-replay");
    const app = await buildDatabaseApp();
    const request = {
      method: "POST" as const,
      url: "/operator/content/bundles/import",
      headers: operatorHeaders,
      payload: replay,
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().result).toEqual({
      createdKnowledge: 0,
      createdQuestions: 0,
      newVersions: 0,
      unchanged: 2,
    });
    const [tracking] = await database.select({ value: count() })
      .from(contentBundleVersions)
      .where(eq(contentBundleVersions.bundleId, replay.bundleId));
    const [knowledgeVersionCount] = await database.select({ value: count() })
      .from(knowledgePointVersions)
      .innerJoin(knowledgePoints, eq(knowledgePointVersions.knowledgePointId, knowledgePoints.id))
      .where(eq(knowledgePoints.canonicalId, replay.knowledgePoints[0]!.canonicalId));
    const [questionVersionCount] = await database.select({ value: count() })
      .from(questionVersions)
      .innerJoin(questions, eq(questionVersions.questionId, questions.id))
      .where(eq(questions.externalKey, replay.questions[0]!.externalKey));
    const [audits] = await database.select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, replay.bundleId));
    expect(tracking!.value).toBe(1);
    expect(knowledgeVersionCount!.value).toBe(1);
    expect(questionVersionCount!.value).toBe(1);
    expect(audits!.value).toBe(4);
  });

  it("rolls back all import and publication state when audit append fails", async () => {
    class FailingAuditService extends AuditService {
      private calls = 0;

      override async record(transaction: ContentTransaction, event: AuditEventInput): Promise<void> {
        this.calls += 1;
        if (this.calls === 2) throw new Error("audit unavailable");
        return super.record(transaction, event);
      }
    }
    const rollbackBundle = createUniqueBundle("audit-rollback");
    const app = await buildApp({
      actorPlugin: {
        provider: new DevIdentityProvider(),
        nodeEnv: "test",
        devIdentityEnabled: true,
      },
      contentRoutes: {
        database,
        contentService,
        contentRepository,
        auditService: new FailingAuditService(new AuditRepository()),
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/operator/content/bundles/import",
      headers: operatorHeaders,
      payload: rollbackBundle,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: "INTERNAL_ERROR" });
    expect(await database.select().from(contentBundles)
      .where(eq(contentBundles.bundleId, rollbackBundle.bundleId))).toEqual([]);
    expect(await database.select().from(auditEvents)
      .where(eq(auditEvents.subjectId, rollbackBundle.bundleId))).toEqual([]);
  });

  it("rolls back all import state when publication fails", async () => {
    class FailingPublicationRepository extends ContentRepository {
      override async publishBundleRevision(
        _transaction: ContentTransaction,
        _bundleId: string,
        _version: number,
      ): Promise<void> {
        throw new Error("publication unavailable");
      }
    }
    const repository = new FailingPublicationRepository();
    const service = new ContentService(database, repository);
    const rollbackBundle = createUniqueBundle("publication-rollback");
    const app = await buildApp({
      actorPlugin: {
        provider: new DevIdentityProvider(),
        nodeEnv: "test",
        devIdentityEnabled: true,
      },
      contentRoutes: {
        database,
        contentService: service,
        contentRepository: repository,
        auditService,
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/operator/content/bundles/import",
      headers: operatorHeaders,
      payload: rollbackBundle,
    });

    expect(response.statusCode).toBe(500);
    expect(await database.select().from(contentBundles)
      .where(eq(contentBundles.bundleId, rollbackBundle.bundleId))).toEqual([]);
    expect(await database.select().from(auditEvents)
      .where(eq(auditEvents.subjectId, rollbackBundle.bundleId))).toEqual([]);
  });

  it("opens one outer transaction and shares its identity across import, publication, and audit", async () => {
    const seen: ContentTransaction[] = [];
    class RecordingRepository extends ContentRepository {
      override async publishBundleRevision(
        transaction: ContentTransaction,
        bundleId: string,
        version: number,
      ): Promise<void> {
        seen.push(transaction);
        return super.publishBundleRevision(transaction, bundleId, version);
      }
    }
    class RecordingService extends ContentService {
      override async importBundle(
        input: ContentBundle,
        actor: Actor,
        transaction?: ContentTransaction,
      ): Promise<ImportResult> {
        if (transaction !== undefined) seen.push(transaction);
        return super.importBundle(input, actor, transaction);
      }
    }
    class RecordingAuditService extends AuditService {
      override record(transaction: ContentTransaction, event: AuditEventInput): Promise<void> {
        seen.push(transaction);
        return super.record(transaction, event);
      }
    }
    let outerCount = 0;
    let outerTransaction: ContentTransaction | undefined;
    const transactionHost: NonNullable<ContentRoutesOptions["database"]> = {
      transaction: async (callback) => {
        outerCount += 1;
        return database.transaction(async (transaction) => {
          outerTransaction = transaction;
          return callback(transaction);
        });
      },
    };
    const repository = new RecordingRepository();
    const service = new RecordingService(transactionHost, repository);
    const recordingAudit = new RecordingAuditService(new AuditRepository());
    const app = await buildApp({
      actorPlugin: {
        provider: new DevIdentityProvider(),
        nodeEnv: "test",
        devIdentityEnabled: true,
      },
      contentRoutes: {
        database: transactionHost,
        contentService: service,
        contentRepository: repository,
        auditService: recordingAudit,
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/operator/content/bundles/import",
      headers: operatorHeaders,
      payload: createUniqueBundle("transaction-identity"),
    });

    expect(response.statusCode).toBe(201);
    expect(outerCount).toBe(1);
    expect(seen).toHaveLength(4);
    expect(seen.every((transaction) => transaction === outerTransaction)).toBe(true);
  });

  it("exposes the import route through the database-backed application composition", async () => {
    const app = await buildApp({
      actorPlugin: {
        provider: new DevIdentityProvider(),
        nodeEnv: "test",
        devIdentityEnabled: true,
      },
      ...databaseRouteOptions(database),
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/operator/content/bundles/import",
      headers: operatorHeaders,
      payload: createUniqueBundle("composition-route"),
    });

    expect(response.statusCode).toBe(201);
  });
});
