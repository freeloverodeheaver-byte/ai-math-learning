import type { Actor } from "@math/contracts";
import type { FastifyRequest } from "fastify";

export interface IdentityProvider {
  resolve(request: FastifyRequest): Promise<Actor | null>;
}

export class AnonymousIdentityProvider implements IdentityProvider {
  async resolve(_request: FastifyRequest): Promise<Actor | null> {
    return null;
  }
}
