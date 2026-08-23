import { readFile } from "node:fs/promises";
import { ContentBundleSchema } from "@math/contracts";
import { describe, expect, it } from "vitest";
import { resolveBundlePath } from "../src/modules/content/seed.js";

describe("resolveBundlePath", () => {
  it("ships a version-two seed with explicit non-AI provenance", async () => {
    const seedUrl = new URL("../../../seed/mock-content-grade-7-semester-1.json", import.meta.url);
    const bundle = ContentBundleSchema.parse(JSON.parse(await readFile(seedUrl, "utf8")));

    expect(bundle.version).toBe(2);
    expect(bundle.questions.every((question) =>
      question.sourceKind === "simulated" &&
      question.sourceReference.length > 0 &&
      question.sourceUsageBasis.length > 0
    )).toBe(true);
  });

  it("accepts the pnpm argument separator before the bundle path", () => {
    expect(resolveBundlePath(["--", "../../seed/mock-content.json"]))
      .toBe("../../seed/mock-content.json");
  });

  it("rejects a missing bundle path", () => {
    expect(() => resolveBundlePath(["--"])).toThrow("A content bundle JSON path is required");
  });
});
