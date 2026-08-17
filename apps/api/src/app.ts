import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { registerHealthRoutes } from "./modules/health/routes.js";
import { DevIdentityProvider } from "./modules/identity/dev-identity-provider.js";
import { AnonymousIdentityProvider } from "./modules/identity/identity-provider.js";
import { registerActorPlugin, type ActorPluginOptions } from "./plugins/actor.js";

export interface BuildAppOptions {
  logger?: boolean;
  actorPlugin?: ActorPluginOptions;
}

export function actorPluginOptionsFromConfig(config: AppConfig): ActorPluginOptions {
  return {
    provider: config.DEV_IDENTITY_ENABLED
      ? new DevIdentityProvider()
      : new AnonymousIdentityProvider(),
    nodeEnv: config.NODE_ENV,
    devIdentityEnabled: config.DEV_IDENTITY_ENABLED,
  };
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  await registerActorPlugin(app, options.actorPlugin ?? {
    provider: new AnonymousIdentityProvider(),
    nodeEnv: "development",
    devIdentityEnabled: false,
  });
  await app.register(registerHealthRoutes);

  return app;
}
