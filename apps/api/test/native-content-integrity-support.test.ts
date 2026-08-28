import { describe, expect, it } from "vitest";
import { isExpectedPostgresRejection } from "./native-content-integrity-support.js";

describe("isExpectedPostgresRejection", () => {
  it("accepts only P0001 with the exact invariant trigger message", () => {
    expect(isExpectedPostgresRejection(
      { code: "P0001", message: "question version relationship snapshot is locked" },
      "question version relationship snapshot is locked",
    )).toBe(true);
  });

  it("accepts the exact PostgreSQL rejection through a Drizzle query-error cause", () => {
    expect(isExpectedPostgresRejection(
      {
        message: "Failed query: insert into relationship snapshot",
        cause: {
          code: "P0001",
          message: "question version relationship snapshot is locked",
        },
      },
      "question version relationship snapshot is locked",
    )).toBe(true);
  });

  it.each([
    [{ code: "23503", message: "question version relationship snapshot is locked" }, "foreign-key violation"],
    [{ code: "23505", message: "question version relationship snapshot is locked" }, "unique violation"],
    [{ code: "P0001", message: "other trigger" }, "unrelated trigger"],
    [{ message: "Failed query", cause: { code: "23503", message: "foreign key" } }, "nested foreign-key violation"],
    [{ code: "P0001", message: "question version relationship snapshot is locked later" }, "message suffix"],
    [new Error("connection terminated"), "connection failure"],
  ])("rejects an unexpected %s error (%s)", (error, _caseName) => {
    expect(isExpectedPostgresRejection(
      error,
      "question version relationship snapshot is locked",
    )).toBe(false);
  });
});
