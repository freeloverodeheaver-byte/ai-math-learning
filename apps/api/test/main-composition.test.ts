import type { FastifyInstance } from "fastify";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  capturedApp: undefined as FastifyInstance | undefined,
  end: vi.fn(async () => undefined),
  factoryCalls: 0,
  listen: vi.fn(async () => "http://127.0.0.1:3001"),
}));

vi.mock("@math/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@math/db")>();
  return {
    ...actual,
    createDb: vi.fn(() => ({
      $client: { end: state.end },
      delete: vi.fn(),
      insert: vi.fn(),
      select: vi.fn(),
      transaction: vi.fn(),
      update: vi.fn(),
    })),
  };
});

vi.mock("../src/app.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app.js")>();
  return {
    ...actual,
    buildApp: async (options: Parameters<typeof actual.buildApp>[0]) => {
      const app = await actual.buildApp(options);
      app.listen = state.listen as typeof app.listen;
      state.capturedApp = app;
      return app;
    },
  };
});

vi.mock("../src/composition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/composition.js")>();
  return {
    ...actual,
    buildProductionApp: async (
      options: Parameters<typeof actual.buildProductionApp>[0],
    ) => {
      state.factoryCalls += 1;
      return actual.buildProductionApp(options);
    },
  };
});

afterEach(async () => {
  if (state.capturedApp !== undefined) await state.capturedApp.close();
  vi.unstubAllEnvs();
});

it("runs the main entrypoint through the lifecycle-owning production factory", async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_URL", "postgresql://foundation:foundation@127.0.0.1:5432/foundation");
  vi.stubEnv("PORT", "3001");
  vi.stubEnv("DEV_IDENTITY_ENABLED", "false");

  await import("../src/main.js");

  expect(state.factoryCalls).toBe(1);
  expect(state.listen).toHaveBeenCalledOnce();
});
