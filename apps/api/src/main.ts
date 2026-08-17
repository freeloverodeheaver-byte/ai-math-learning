import { createDb } from "@math/db";
import { actorPluginOptionsFromConfig, buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { AccessRepository } from "./modules/access/repository.js";
import { AccessService } from "./modules/access/service.js";

const config = loadConfig(process.env);
const database = config.DATABASE_URL === undefined ? undefined : createDb(config.DATABASE_URL);
const repository = database === undefined ? undefined : new AccessRepository(database);
const app = await buildApp({
  actorPlugin: actorPluginOptionsFromConfig(config),
  accessRoutes: database === undefined || repository === undefined
    ? undefined
    : {
        repository,
        service: new AccessService(database, repository),
      },
});

if (database !== undefined) {
  app.addHook("onClose", async () => {
    await database.$client.end();
  });
}

await app.listen({ host: "0.0.0.0", port: config.PORT });
