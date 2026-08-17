import { describe, expect, it } from "vitest";
import { resolveBundlePath } from "../src/modules/content/seed.js";

describe("resolveBundlePath", () => {
  it("accepts the pnpm argument separator before the bundle path", () => {
    expect(resolveBundlePath(["--", "../../seed/mock-content.json"]))
      .toBe("../../seed/mock-content.json");
  });

  it("rejects a missing bundle path", () => {
    expect(() => resolveBundlePath(["--"])).toThrow("A content bundle JSON path is required");
  });
});
