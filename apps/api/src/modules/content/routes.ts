import { ContentBundleSchema } from "@math/contracts";
import type { FastifyPluginAsync } from "fastify";
import { ForbiddenError, requireActor, requireRole } from "../../plugins/actor.js";
import type { AuditService } from "../audit/service.js";
import type { ContentRepository, ContentTransaction } from "./repository.js";
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
}

export const registerContentRoutes: FastifyPluginAsync<ContentRoutesOptions> = async (app, options) => {
  app.post("/operator/content/bundles/validate", async (request, reply) => {
    const actor = requireActor(request);
    requireRole(actor, ["operator"]);
    const parsed = ContentBundleSchema.safeParse(request.body);
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
    const parsed = ContentBundleSchema.safeParse(request.body);
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
    if (
      database === undefined ||
      contentService === undefined ||
      contentRepository === undefined ||
      auditService === undefined
    ) {
      return reply.code(503).send({ code: "CONTENT_IMPORT_UNAVAILABLE" });
    }

    try {
      const result = await database.transaction(async (transaction) => {
        const imported = await contentService.importBundle(parsed.data, actor, transaction);
        await contentRepository.publishBundleRevision(
          transaction,
          parsed.data.bundleId,
          parsed.data.version,
        );
        await auditService.record(transaction, {
          actorUserId: actor.userId,
          action: "content.bundle.imported",
          subjectType: "content_bundle",
          subjectId: parsed.data.bundleId,
          metadata: {
            bundleId: parsed.data.bundleId,
            version: parsed.data.version,
            result: imported,
          },
        });
        await auditService.record(transaction, {
          actorUserId: actor.userId,
          action: "content.bundle.published",
          subjectType: "content_bundle",
          subjectId: parsed.data.bundleId,
          metadata: { bundleId: parsed.data.bundleId, version: parsed.data.version },
        });
        return imported;
      });
      return reply.code(201).send({
        bundleId: parsed.data.bundleId,
        version: parsed.data.version,
        result,
      });
    } catch (error) {
      if (error instanceof ContentVersionRegressionError) {
        return reply.code(error.statusCode).send({ code: error.code });
      }
      return reply.code(500).send({ code: "INTERNAL_ERROR" });
    }
  });
};
