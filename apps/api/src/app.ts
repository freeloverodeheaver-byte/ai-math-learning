import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import {
  registerAccessRoutes,
  type AccessRoutesOptions,
} from "./modules/access/routes.js";
import {
  registerContentRoutes,
  type ContentRoutesOptions,
} from "./modules/content/routes.js";
import { registerHealthRoutes } from "./modules/health/routes.js";
import { DevIdentityProvider } from "./modules/identity/dev-identity-provider.js";
import { AnonymousIdentityProvider } from "./modules/identity/identity-provider.js";
import {
  ForbiddenError,
  registerActorPlugin,
  UnauthorizedError,
  type ActorPluginOptions,
} from "./plugins/actor.js";

export interface BuildAppOptions {
  logger?: boolean;
  actorPlugin?: ActorPluginOptions;
  accessRoutes?: AccessRoutesOptions;
  contentRoutes?: ContentRoutesOptions;
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

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return reply.code(error.statusCode).send({ code: error.code });
    }
    return reply.send(error);
  });

  await registerActorPlugin(app, options.actorPlugin ?? {
    provider: new AnonymousIdentityProvider(),
    nodeEnv: "development",
    devIdentityEnabled: false,
  });
  await app.register(registerContentRoutes, options.contentRoutes ?? {});
  if (options.accessRoutes !== undefined) {
    await app.register(registerAccessRoutes, options.accessRoutes);
  }
  await app.register(registerHealthRoutes);

  return app;
}
