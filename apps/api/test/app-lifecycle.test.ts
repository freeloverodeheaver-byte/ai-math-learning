import { createDb } from "@math/db";
import { expect, it, vi } from "vitest";
import { buildProductionApp } from "../src/composition.js";

it("closes the injected production database client exactly once", async () => {
  const database = createDb("postgresql://unused:unused@127.0.0.1:1/unused");
  const end = vi.spyOn(database.$client, "end");
  try {
    const app = await buildProductionApp({
      config: {
        NODE_ENV: "test",
        PORT: 3000,
        DEV_IDENTITY_ENABLED: true,
      },
      database,
    });

    await app.close();

    expect(end).toHaveBeenCalledTimes(1);
  } finally {
    if (end.mock.calls.length === 0) await database.$client.end();
  }
});
