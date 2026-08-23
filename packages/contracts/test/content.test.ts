import { describe, expect, it } from "vitest";
import { ContentBundleSchema } from "../src/index.js";

const completeBundle = {
  bundleId: "mock-g7-s1",
  version: 1,
  knowledgePoints: [
    {
      canonicalId: "g7s1.rational",
      name: "有理数",
      grade: 7,
      semester: 1,
      prerequisites: []
    }
  ],
  questions: [
    {
      externalKey: "mock-q-001",
      stem: "计算：-2+5",
      answer: "3",
      explanation: "异号相加，取绝对值较大数的符号。",
      knowledgeCanonicalIds: ["g7s1.rational"],
      difficulty: 1,
      sourceLabel: "MVP simulated content",
      sourceKind: "simulated",
      sourceReference: "fixture:mock-g7-s1",
      sourceUsageBasis: "synthetic test fixture"
    }
  ]
} as const;

describe("ContentBundleSchema", () => {
  it("accepts explicit source provenance including AI-generated draft content", () => {
    const parsed = ContentBundleSchema.parse({
      ...completeBundle,
      questions: [{
        ...completeBundle.questions[0],
        sourceKind: "ai_generated",
        sourceReference: "generation-run-2026-08-23",
        sourceUsageBasis: "internal evaluation only"
      }]
    });

    expect(parsed.questions[0]?.sourceKind).toBe("ai_generated");
  });

  it("requires source kind, reference, and usage basis", () => {
    const {
      sourceKind: _sourceKind,
      sourceReference: _sourceReference,
      sourceUsageBasis: _sourceUsageBasis,
      ...withoutProvenance
    } = completeBundle.questions[0];
    const parsed = ContentBundleSchema.safeParse({
      ...completeBundle,
      questions: [withoutProvenance]
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["questions", 0, "sourceKind"], code: "invalid_value" }),
      expect.objectContaining({ path: ["questions", 0, "sourceReference"], code: "invalid_type" }),
      expect.objectContaining({ path: ["questions", 0, "sourceUsageBasis"], code: "invalid_type" })
    ]));
  });

  it("rejects whitespace-only substantive question and provenance fields", () => {
    const parsed = ContentBundleSchema.safeParse({
      ...completeBundle,
      questions: [{
        ...completeBundle.questions[0],
        answer: "   ",
        explanation: "   ",
        sourceLabel: "   ",
        sourceKind: "simulated",
        sourceReference: "   ",
        sourceUsageBasis: "   "
      }]
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["questions", 0, "answer"], code: "too_small" }),
      expect.objectContaining({ path: ["questions", 0, "explanation"], code: "too_small" }),
      expect.objectContaining({ path: ["questions", 0, "sourceLabel"], code: "too_small" }),
      expect.objectContaining({ path: ["questions", 0, "sourceReference"], code: "too_small" }),
      expect.objectContaining({ path: ["questions", 0, "sourceUsageBasis"], code: "too_small" })
    ]));
  });

  it("rejects conflicting provenance for one source label inside a bundle", () => {
    const parsed = ContentBundleSchema.safeParse({
      ...completeBundle,
      questions: [
        completeBundle.questions[0],
        {
          ...completeBundle.questions[0],
          externalKey: "mock-q-002",
          sourceKind: "licensed",
          sourceReference: "license-b",
          sourceUsageBasis: "licensed for training"
        }
      ]
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toContainEqual(expect.objectContaining({
      path: ["questions", 1, "sourceLabel"],
      code: "custom",
      message: expect.stringMatching(/conflicting source provenance/i)
    }));
  });

  it("accepts complete mock content", () => {
    const parsed = ContentBundleSchema.parse(completeBundle);

    expect(parsed.questions[0]?.externalKey).toBe("mock-q-001");
  });

  it("rejects a question without answer or explanation", () => {
    const invalid = {
      bundleId: "bad",
      version: 1,
      knowledgePoints: completeBundle.knowledgePoints,
      questions: [{ externalKey: "q" }]
    };

    expect(() => ContentBundleSchema.parse(invalid)).toThrow();
  });

  it("rejects a question without a knowledge relationship", () => {
    const parsed = ContentBundleSchema.safeParse({
      ...completeBundle,
      questions: [{ ...completeBundle.questions[0], knowledgeCanonicalIds: [] }]
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toContainEqual(expect.objectContaining({
      path: ["questions", 0, "knowledgeCanonicalIds"],
      code: "too_small",
      message: expect.any(String)
    }));
  });

  it("rejects the reserved legacy bundle ID", () => {
    expect(() => ContentBundleSchema.parse({
      ...completeBundle,
      bundleId: "__legacy_pre_import__"
    })).toThrow(/reserved/i);
  });

  it("rejects unknown fields at every bundle level", () => {
    expect(() => ContentBundleSchema.parse({ ...completeBundle, unexpected: true })).toThrow();
    expect(() => ContentBundleSchema.parse({
      ...completeBundle,
      knowledgePoints: [{ ...completeBundle.knowledgePoints[0], unexpected: true }]
    })).toThrow();
    expect(() => ContentBundleSchema.parse({
      ...completeBundle,
      questions: [{ ...completeBundle.questions[0], unexpected: true }]
    })).toThrow();
  });

  it.each([
    ["duplicate knowledge canonical IDs", {
      ...completeBundle,
      knowledgePoints: [completeBundle.knowledgePoints[0], completeBundle.knowledgePoints[0]]
    }],
    ["duplicate question external keys", {
      ...completeBundle,
      questions: [completeBundle.questions[0], completeBundle.questions[0]]
    }],
    ["duplicate prerequisite IDs", {
      ...completeBundle,
      knowledgePoints: [
        completeBundle.knowledgePoints[0],
        {
          canonicalId: "g7s1.number-line",
          name: "数轴",
          grade: 7,
          semester: 1,
          prerequisites: ["g7s1.rational", "g7s1.rational"]
        }
      ]
    }],
    ["duplicate question knowledge links", {
      ...completeBundle,
      questions: [{
        ...completeBundle.questions[0],
        knowledgeCanonicalIds: ["g7s1.rational", "g7s1.rational"]
      }]
    }]
  ])("rejects %s", (_label, invalid) => {
    expect(() => ContentBundleSchema.parse(invalid)).toThrow();
  });

  it.each([
    ["unknown prerequisites", {
      ...completeBundle,
      knowledgePoints: [{
        ...completeBundle.knowledgePoints[0],
        prerequisites: ["g7s1.unknown"]
      }]
    }],
    ["unknown question knowledge IDs", {
      ...completeBundle,
      questions: [{
        ...completeBundle.questions[0],
        knowledgeCanonicalIds: ["g7s1.unknown"]
      }]
    }]
  ])("rejects %s", (_label, invalid) => {
    expect(() => ContentBundleSchema.parse(invalid)).toThrow();
  });
});
