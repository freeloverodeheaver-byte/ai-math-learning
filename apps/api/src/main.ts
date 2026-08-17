import { actorPluginOptionsFromConfig, buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig(process.env);
const app = await buildApp({ actorPlugin: actorPluginOptionsFromConfig(config) });

await app.listen({ host: "0.0.0.0", port: config.PORT });
