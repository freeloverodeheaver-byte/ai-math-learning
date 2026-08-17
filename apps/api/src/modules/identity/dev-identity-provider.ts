import { RoleSchema, type Actor, type Role } from "@math/contracts";
import type { FastifyRequest } from "fastify";
import type { IdentityProvider } from "./identity-provider.js";

const developmentIdentityProviderMarker = Symbol("developmentIdentityProvider");

type MarkedDevelopmentIdentityProvider = IdentityProvider & {
  [developmentIdentityProviderMarker]?: true;
};

export class DevIdentityProvider implements IdentityProvider {
  readonly [developmentIdentityProviderMarker] = true;

  async resolve(request: FastifyRequest): Promise<Actor | null> {
    const userIdHeader = singleIdentityHeader(request, "x-dev-user-id");
    const rolesHeader = singleIdentityHeader(request, "x-dev-roles");

    if (userIdHeader === null || rolesHeader === null) {
      return null;
    }

    const userId = userIdHeader.trim();
    const roleValues = rolesHeader.split(",").map((value) => value.trim());
    if (
      userId.length === 0 ||
      userId.includes(",") ||
      roleValues.length === 0 ||
      roleValues.some((value) => value.length === 0)
    ) {
      return null;
    }

    const roles: Role[] = [];
    for (const roleValue of roleValues) {
      const parsedRole = RoleSchema.safeParse(roleValue);
      if (!parsedRole.success) {
        return null;
      }
      if (!roles.includes(parsedRole.data)) {
        roles.push(parsedRole.data);
      }
    }

    return { userId, roles };
  }
}

function singleIdentityHeader(
  request: FastifyRequest,
  headerName: "x-dev-user-id" | "x-dev-roles",
): string | null {
  const headersDistinct = request.raw?.headersDistinct;
  if (headersDistinct !== undefined) {
    const values = headersDistinct[headerName];
    return Array.isArray(values) && values.length === 1 ? values[0] ?? null : null;
  }

  const header = request.headers[headerName];
  return typeof header === "string" ? header : null;
}

export function isDevIdentityProvider(
  provider: IdentityProvider,
): provider is MarkedDevelopmentIdentityProvider {
  return (provider as MarkedDevelopmentIdentityProvider)[developmentIdentityProviderMarker] === true;
}
