import * as http from "node:http";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import type { Actor } from "@math/contracts";
import { actorPluginOptionsFromConfig, buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { DevIdentityProvider } from "../src/modules/identity/dev-identity-provider.js";
import type { IdentityProvider } from "../src/modules/identity/identity-provider.js";
import {
  registerActorPlugin,
  requireActor,
  requireRole,
} from "../src/plugins/actor.js";

const operator: Actor = { userId: "operator-1", roles: ["operator"] };

function requestWithHeaders(headers: Record<string, string | string[] | undefined>): FastifyRequest {
  return { headers } as FastifyRequest;
}

async function buildProbeApp(provider: IdentityProvider) {
  const app = Fastify({ logger: false });
  await registerActorPlugin(app, {
    provider,
    nodeEnv: "test",
    devIdentityEnabled: true,
  });
  app.get("/operator-probe", async (request) => {
    const actor = requireActor(request);
    requireRole(actor, ["operator"]);
    return { actor };
  });
  return app;
}

async function injectRawHeaders(
  app: FastifyInstance,
  headers: string[],
): Promise<{ statusCode: number; body: unknown }> {
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fastify did not bind a TCP address");
  }

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        method: "GET",
        path: "/operator-probe",
        headers: ["host", "127.0.0.1", ...headers],
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: responseBody.length === 0 ? null : JSON.parse(responseBody),
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

describe("requireRole", () => {
  it("allows an operator on an operator-only route", () => {
    expect(() => requireRole(operator, ["operator"])).not.toThrow();
  });

  it("rejects a teacher on an operator-only route", () => {
    expect(() => requireRole({ userId: "teacher-1", roles: ["teacher"] }, ["operator"])).toThrow(
      "FORBIDDEN",
    );
  });

  it("allows an actor when any assigned role is permitted", () => {
    expect(() =>
      requireRole({ userId: "multi-1", roles: ["teacher", "operator"] }, ["operator"]),
    ).not.toThrow();
  });

  it("rejects an actor when no roles are permitted", () => {
    expect(() => requireRole(operator, [])).toThrow("FORBIDDEN");
  });
});

describe("DevIdentityProvider", () => {
  const provider = new DevIdentityProvider();

  it("parses exact actor values after trimming and deduplicating roles", async () => {
    await expect(
      provider.resolve(
        requestWithHeaders({
          "x-dev-user-id": "  user-1  ",
          "x-dev-roles": " teacher, operator, teacher ",
        }),
      ),
    ).resolves.toEqual({ userId: "user-1", roles: ["teacher", "operator"] });
  });

  it.each([
    ["missing identity headers", {}],
    ["empty user id", { "x-dev-user-id": "  ", "x-dev-roles": "operator" }],
    ["empty roles", { "x-dev-user-id": "user-1", "x-dev-roles": "  " }],
    ["invalid role", { "x-dev-user-id": "user-1", "x-dev-roles": "operator, admin" }],
    ["comma-joined user id", { "x-dev-user-id": "user-1,user-2", "x-dev-roles": "operator" }],
    ["array user id", { "x-dev-user-id": ["user-1"], "x-dev-roles": "operator" }],
    ["array roles", { "x-dev-user-id": "user-1", "x-dev-roles": ["operator"] }],
  ])("resolves %s as no actor", async (_name, headers) => {
    await expect(provider.resolve(requestWithHeaders(headers))).resolves.toBeNull();
  });
});

describe("actor plugin startup guard", () => {
  it("composes the config-selected development provider through buildApp", async () => {
    const app = await buildApp({
      actorPlugin: actorPluginOptionsFromConfig(
        loadConfig({ NODE_ENV: "development", DEV_IDENTITY_ENABLED: "true" }),
      ),
    });
    app.get("/config-probe", async (request) => ({ actor: requireActor(request) }));

    const response = await app.inject({
      method: "GET",
      url: "/config-probe",
      headers: { "x-dev-user-id": "operator-1", "x-dev-roles": "operator" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ actor: operator });
    await app.close();
  });

  it("rejects production development identity through the config composition path", async () => {
    const options = actorPluginOptionsFromConfig(
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://math:math@localhost:5432/math",
        DEV_IDENTITY_ENABLED: "true",
      }),
    );

    await expect(buildApp({ actorPlugin: options })).rejects.toThrow(
      "development identity provider",
    );
  });

  it("uses anonymous identity when development identity is disabled", async () => {
    const app = await buildApp({
      actorPlugin: actorPluginOptionsFromConfig(
        loadConfig({ NODE_ENV: "test", DEV_IDENTITY_ENABLED: "false" }),
      ),
    });
    app.get("/disabled-config-probe", async (request) => ({ actor: requireActor(request) }));

    const response = await app.inject({
      method: "GET",
      url: "/disabled-config-probe",
      headers: { "x-dev-user-id": "operator-1", "x-dev-roles": "operator" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "UNAUTHORIZED" });
    await app.close();
  });

  it("rejects the development provider in production even when enabled", async () => {
    const app = Fastify();
    await expect(
      registerActorPlugin(app, {
        provider: new DevIdentityProvider(),
        nodeEnv: "production",
        devIdentityEnabled: true,
      }),
    ).rejects.toThrow("development identity provider");
    await app.close();
  });

  it("rejects the development provider when the feature flag is disabled", async () => {
    const app = Fastify();
    await expect(
      registerActorPlugin(app, {
        provider: new DevIdentityProvider(),
        nodeEnv: "test",
        devIdentityEnabled: false,
      }),
    ).rejects.toThrow("development identity provider");
    await app.close();
  });

  it("accepts the development provider outside production when enabled", async () => {
    const app = Fastify();
    await registerActorPlugin(app, {
      provider: new DevIdentityProvider(),
      nodeEnv: "development",
      devIdentityEnabled: true,
    });

    await app.ready();
    await app.close();
  });

  it("does not apply the development guard to another provider", async () => {
    const provider: IdentityProvider = { resolve: async () => null };
    const app = Fastify();
    await registerActorPlugin(app, {
      provider,
      nodeEnv: "production",
      devIdentityEnabled: false,
    });

    await app.ready();
    await app.close();
  });
});

describe("actor route policy", () => {
  it("fails closed when a bare Fastify route calls requireActor", async () => {
    const app = Fastify({ logger: false });
    app.get("/bare-probe", async (request) => ({ actor: requireActor(request) }));

    const response = await app.inject({ method: "GET", url: "/bare-probe" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "UNAUTHORIZED" });
    await app.close();
  });

  it("decorates default buildApp requests with a null anonymous actor", async () => {
    const app = await buildApp();
    app.get("/actor-state", async (request) => ({ actor: request.actor }));

    const response = await app.inject({ method: "GET", url: "/actor-state" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ actor: null });
    await app.close();
  });

  it("keeps health public while composing an injected identity provider", async () => {
    let resolveCount = 0;
    const provider: IdentityProvider = {
      resolve: async () => {
        resolveCount += 1;
        return null;
      },
    };
    const app = await buildApp({
      actorPlugin: {
        provider,
        nodeEnv: "production",
        devIdentityEnabled: false,
      },
    });

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "api" });
    expect(resolveCount).toBe(1);
    await app.close();
  });

  it("returns 401 for missing or malformed identity headers", async () => {
    const app = await buildProbeApp(new DevIdentityProvider());

    for (const headers of [{}, { "x-dev-user-id": "user-1", "x-dev-roles": "admin" }]) {
      const response = await app.inject({ method: "GET", url: "/operator-probe", headers });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: "UNAUTHORIZED" });
    }

    await app.close();
  });

  it("returns 403 for a recognized actor without the required role", async () => {
    const app = await buildProbeApp(new DevIdentityProvider());
    const response = await app.inject({
      method: "GET",
      url: "/operator-probe",
      headers: { "x-dev-user-id": "teacher-1", "x-dev-roles": "teacher" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "FORBIDDEN" });
    await app.close();
  });

  it("returns the resolved operator actor", async () => {
    const app = await buildProbeApp(new DevIdentityProvider());
    const response = await app.inject({
      method: "GET",
      url: "/operator-probe",
      headers: { "x-dev-user-id": "operator-1", "x-dev-roles": "operator" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ actor: operator });
    await app.close();
  });

  it("rejects duplicate physical development identity headers over HTTP", async () => {
    const app = await buildProbeApp(new DevIdentityProvider());
    await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      const response = await injectRawHeaders(app, [
        "x-dev-user-id",
        "operator-1",
        "x-dev-user-id",
        "operator-2",
        "x-dev-roles",
        "operator",
        "x-dev-roles",
        "teacher",
      ]);
      expect(response.statusCode).toBe(401);
      expect(response.body).toMatchObject({ code: "UNAUTHORIZED" });
    } finally {
      await app.close();
    }
  });

  it("accepts one physical comma-separated development roles header over HTTP", async () => {
    const app = await buildProbeApp(new DevIdentityProvider());
    await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      const response = await injectRawHeaders(app, [
        "x-dev-user-id",
        "operator-1",
        "x-dev-roles",
        "operator,teacher",
      ]);
      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({
        actor: { userId: "operator-1", roles: ["operator", "teacher"] },
      });
    } finally {
      await app.close();
    }
  });

  it("keeps actors isolated between injected requests", async () => {
    const app = await buildProbeApp(new DevIdentityProvider());
    const first = await app.inject({
      method: "GET",
      url: "/operator-probe",
      headers: { "x-dev-user-id": "operator-1", "x-dev-roles": "operator" },
    });
    const second = await app.inject({ method: "GET", url: "/operator-probe" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(401);
    await app.close();
  });

  it("resolves identity exactly once per request, including a public route", async () => {
    let resolveCount = 0;
    const provider: IdentityProvider = {
      resolve: async () => {
        resolveCount += 1;
        return null;
      },
    };
    const app = Fastify({ logger: false });
    await registerActorPlugin(app, {
      provider,
      nodeEnv: "production",
      devIdentityEnabled: false,
    });
    app.get("/public", async () => ({ public: true }));

    const response = await app.inject({ method: "GET", url: "/public" });
    expect(response.statusCode).toBe(200);
    expect(resolveCount).toBe(1);
    await app.close();
  });
});
