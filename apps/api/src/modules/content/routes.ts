import type { FastifyPluginAsync } from "fastify";
import { ForbiddenError, requireActor, requireRole } from "../../plugins/actor.js";
import type { AuditService } from "../audit/service.js";
import {
  ContentImportWorkflow,
  PublishableContentBundleSchema,
} from "./import-workflow.js";
import {
  SourceProvenanceConflictError,
  type ContentRepository,
  type ContentTransaction,
} from "./repository.js";
import {
  ContentVersionRegressionError,
  type ContentService,
  type ContentTransactionHost,
} from "./service.js";

export interface ContentRoutesOptions {
  database?: ContentTransactionHost;
  contentService?: ContentService;
  contentRepository?: ContentRepository;
  auditService?: AuditService;
  importWorkflow?: ContentImportWorkflow;
}

export const registerContentRoutes: FastifyPluginAsync<ContentRoutesOptions> = async (app, options) => {
  app.get("/operator/content/questions/published", async (request, reply) => {
    const actor = requireActor(request);
    requireRole(actor, ["operator"]);
    const { database, contentRepository } = options;
    if (database === undefined || contentRepository === undefined) {
      return reply.code(503).send({ code: "CONTENT_READ_UNAVAILABLE" });
    }
    const publishedQuestions = await database.transaction((transaction) =>
      contentRepository.listLatestPublishedQuestions(transaction)
    );
    return { questions: publishedQuestions };
  });

  app.post("/operator/content/bundles/validate", async (request, reply) => {
    const actor = requireActor(request);
    requireRole(actor, ["operator"]);
    const parsed = PublishableContentBundleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({
        code: "INVALID_CONTENT_BUNDLE",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          code: issue.code,
          message: issue.message,
        })),
      });
    }

    return {
      valid: true,
      knowledgePoints: parsed.data.knowledgePoints.length,
      questions: parsed.data.questions.length,
    };
  });

  app.post("/operator/content/bundles/import", async (request, reply) => {
    const actor = requireActor(request);
    try {
      requireRole(actor, ["operator"]);
    } catch (error) {
      if (error instanceof ForbiddenError) {
        return reply.code(403).send({ code: error.code });
      }
      throw error;
    }
    const parsed = PublishableContentBundleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({
        code: "INVALID_CONTENT_BUNDLE",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          code: issue.code,
          message: issue.message,
        })),
      });
    }
    const { database, contentService, contentRepository, auditService } = options;
    const importWorkflow = options.importWorkflow ?? (
      database !== undefined &&
      contentService !== undefined &&
      contentRepository !== undefined &&
      auditService !== undefined
        ? new ContentImportWorkflow(database, contentService, contentRepository, auditService)
        : undefined
    );
    if (importWorkflow === undefined) {
      return reply.code(503).send({ code: "CONTENT_IMPORT_UNAVAILABLE" });
    }

    try {
      const result = await importWorkflow.execute(parsed.data, { actor });
      return reply.code(201).send({
        bundleId: parsed.data.bundleId,
        version: parsed.data.version,
        result,
      });
    } catch (error) {
      if (error instanceof ContentVersionRegressionError) {
        return reply.code(error.statusCode).send({ code: error.code });
      }
      if (error instanceof SourceProvenanceConflictError) {
        return reply.code(error.statusCode).send({ code: error.code });
      }
      return reply.code(500).send({ code: "INTERNAL_ERROR" });
    }
  });
};
