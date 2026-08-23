import type { BuildAppOptions } from "./app.js";
import { AccessRepository, type AccessTransaction } from "./modules/access/repository.js";
import { AccessService } from "./modules/access/service.js";
import { AuditRepository } from "./modules/audit/repository.js";
import { AuditService } from "./modules/audit/service.js";
import { ContentRepository } from "./modules/content/repository.js";
import { ContentService, type ContentTransactionHost } from "./modules/content/service.js";

type ApplicationDatabase = AccessTransaction & ContentTransactionHost;

export function databaseRouteOptions(
  database: ApplicationDatabase,
): Pick<BuildAppOptions, "accessRoutes" | "contentRoutes"> {
  const accessRepository = new AccessRepository(database);
  const contentRepository = new ContentRepository();

  return {
    accessRoutes: {
      repository: accessRepository,
      service: new AccessService(database, accessRepository),
    },
    contentRoutes: {
      database,
      contentRepository,
      contentService: new ContentService(database, contentRepository),
      auditService: new AuditService(new AuditRepository()),
    },
  };
}
