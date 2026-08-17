import type { Actor, Role } from "@math/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isDevIdentityProvider } from "../modules/identity/dev-identity-provider.js";
import type { IdentityProvider } from "../modules/identity/identity-provider.js";

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

export class UnauthorizedError extends Error {
  readonly code = "UNAUTHORIZED";
  readonly statusCode = 401;

  constructor() {
    super("UNAUTHORIZED");
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  readonly code = "FORBIDDEN";
  readonly statusCode = 403;

  constructor() {
    super("FORBIDDEN");
    this.name = "ForbiddenError";
  }
}

export interface ActorPluginOptions {
  provider: IdentityProvider;
  nodeEnv: "development" | "test" | "production";
  devIdentityEnabled: boolean;
}

export async function registerActorPlugin(
  app: FastifyInstance,
  options: ActorPluginOptions,
): Promise<void> {
  if (
    isDevIdentityProvider(options.provider) &&
    (options.nodeEnv === "production" || !options.devIdentityEnabled)
  ) {
    throw new Error("development identity provider is disabled for this environment");
  }

  app.decorateRequest("actor", null);
  app.addHook("onRequest", async (request) => {
    request.actor = await options.provider.resolve(request);
  });
}

export function requireActor(request: FastifyRequest): Actor {
  if (request.actor == null) {
    throw new UnauthorizedError();
  }
  return request.actor;
}

export function requireRole(actor: Actor, allowedRoles: readonly Role[]): void {
  if (!actor.roles.some((role) => allowedRoles.includes(role))) {
    throw new ForbiddenError();
  }
}
