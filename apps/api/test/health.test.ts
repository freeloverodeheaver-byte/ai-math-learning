import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";

describe("GET /health", () => {
  it("returns a deterministic readiness payload", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "api" });
    await app.close();
  });
});

describe("loadConfig", () => {
  it("allows development startup without a database URL", () => {
    expect(loadConfig({ NODE_ENV: "development" })).toEqual({
      NODE_ENV: "development",
      PORT: 3000,
      DEV_IDENTITY_ENABLED: false,
    });
  });

  it("rejects a production startup without a database URL", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(
      "DATABASE_URL is required when NODE_ENV is production",
    );
  });
});
