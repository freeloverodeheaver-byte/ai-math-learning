import Fastify, { type FastifyInstance } from "fastify";
import { registerHealthRoutes } from "./modules/health/routes.js";

export interface BuildAppOptions {
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  await app.register(registerHealthRoutes);

  return app;
}
