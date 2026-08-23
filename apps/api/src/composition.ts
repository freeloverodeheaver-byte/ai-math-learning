import {
  actorPluginOptionsFromConfig,
  buildApp,
  type BuildAppOptions,
} from "./app.js";
import type { AppConfig } from "./config.js";
import { AccessRepository, type AccessTransaction } from "./modules/access/repository.js";
import { AccessService } from "./modules/access/service.js";
import { AuditRepository } from "./modules/audit/repository.js";
import { AuditService } from "./modules/audit/service.js";
import { ContentImportWorkflow } from "./modules/content/import-workflow.js";
import { ContentRepository } from "./modules/content/repository.js";
import { ContentService, type ContentTransactionHost } from "./modules/content/service.js";

type ApplicationDatabase = AccessTransaction & ContentTransactionHost;

interface DatabaseClientOwner {
  $client: {
    end(): Promise<void> | void;
  };
}

export interface BuildProductionAppOptions {
  config: AppConfig;
  database?: ApplicationDatabase & DatabaseClientOwner;
  logger?: boolean;
}

export function databaseRouteOptions(
  database: ApplicationDatabase,
): Pick<BuildAppOptions, "accessRoutes" | "contentRoutes"> {
  const accessRepository = new AccessRepository(database);
  const contentRepository = new ContentRepository();
  const contentService = new ContentService(database, contentRepository);
  const auditService = new AuditService(new AuditRepository());

  return {
    accessRoutes: {
      repository: accessRepository,
      service: new AccessService(database, accessRepository),
    },
    contentRoutes: {
      database,
      contentRepository,
      contentService,
      auditService,
      importWorkflow: new ContentImportWorkflow(
        database,
        contentService,
        contentRepository,
        auditService,
      ),
    },
  };
}

export async function buildProductionApp(
  options: BuildProductionAppOptions,
) {
  const app = await buildApp({
    logger: options.logger,
    actorPlugin: actorPluginOptionsFromConfig(options.config),
    ...(options.database === undefined ? {} : databaseRouteOptions(options.database)),
  });
  if (options.database !== undefined) {
    app.addHook("onClose", async () => {
      await options.database!.$client.end();
    });
  }
  return app;
}
