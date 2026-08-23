import { createDb } from "@math/db";
import { buildProductionApp } from "./composition.js";
import { loadConfig } from "./config.js";

const config = loadConfig(process.env);
const database = config.DATABASE_URL === undefined ? undefined : createDb(config.DATABASE_URL);
const app = await buildProductionApp({
  config,
  database,
});

await app.listen({ host: "0.0.0.0", port: config.PORT });
