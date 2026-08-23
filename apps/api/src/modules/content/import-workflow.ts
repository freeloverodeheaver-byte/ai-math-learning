import { ContentBundleSchema, type Actor, type ContentBundle } from "@math/contracts";
import type { AuditService } from "../audit/service.js";
import type { ContentRepository } from "./repository.js";
import type { ContentService, ContentTransactionHost, ImportResult } from "./service.js";

export const PublishableContentBundleSchema = ContentBundleSchema.superRefine((bundle, context) => {
  for (const [index, question] of bundle.questions.entries()) {
    if (question.sourceKind === "ai_generated") {
      context.addIssue({
        code: "custom",
        message: "AI-generated content cannot be published",
        path: ["questions", index, "sourceKind"],
      });
    }
  }
});

export interface ContentImportContext {
  actor: Actor | null;
  metadata?: Record<string, unknown>;
}

const systemActor: Actor = { userId: "system_seed", roles: ["operator"] };

export class ContentImportWorkflow {
  constructor(
    private readonly database: ContentTransactionHost,
    private readonly contentService: ContentService,
    private readonly contentRepository: ContentRepository,
    private readonly auditService: AuditService,
  ) {}

  async execute(bundle: ContentBundle, context: ContentImportContext): Promise<ImportResult> {
    const publishableBundle = PublishableContentBundleSchema.parse(bundle);
    return this.database.transaction(async (transaction) => {
      const imported = await this.contentService.importBundle(
        publishableBundle,
        context.actor ?? systemActor,
        transaction,
      );
      const publication = await this.contentRepository.publishBundleRevision(
        transaction,
        publishableBundle,
      );
      const auditBase = {
        actorUserId: context.actor?.userId ?? null,
        subjectType: "content_bundle",
        subjectId: publishableBundle.bundleId,
      };
      await this.auditService.record(transaction, {
        ...auditBase,
        action: "content.bundle.imported",
        metadata: {
          ...context.metadata,
          bundleId: publishableBundle.bundleId,
          version: publishableBundle.version,
          result: imported,
        },
      });
      await this.auditService.record(transaction, {
        ...auditBase,
        action: "content.bundle.published",
        metadata: {
          ...context.metadata,
          bundleId: publishableBundle.bundleId,
          version: publishableBundle.version,
          result: publication,
        },
      });
      return imported;
    });
  }
}
