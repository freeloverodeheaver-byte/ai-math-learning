import Fastify, { type FastifyInstance } from "fastify";
import { registerHealthRoutes } from "./modules/health/routes.js";
import { registerActorPlugin, type ActorPluginOptions } from "./plugins/actor.js";

export interface BuildAppOptions {
  logger?: boolean;
  actorPlugin?: ActorPluginOptions;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  if (options.actorPlugin !== undefined) {
    await registerActorPlugin(app, options.actorPlugin);
  }
  await app.register(registerHealthRoutes);

  return app;
}
