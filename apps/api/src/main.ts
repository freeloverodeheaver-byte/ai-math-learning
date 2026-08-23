import { createDb } from "@math/db";
import { actorPluginOptionsFromConfig, buildApp } from "./app.js";
import { databaseRouteOptions } from "./composition.js";
import { loadConfig } from "./config.js";

const config = loadConfig(process.env);
const database = config.DATABASE_URL === undefined ? undefined : createDb(config.DATABASE_URL);
const app = await buildApp({
  actorPlugin: actorPluginOptionsFromConfig(config),
  ...(database === undefined ? {} : databaseRouteOptions(database)),
});

if (database !== undefined) {
  app.addHook("onClose", async () => {
    await database.$client.end();
  });
}

await app.listen({ host: "0.0.0.0", port: config.PORT });
