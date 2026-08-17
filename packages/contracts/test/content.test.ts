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
      sourceLabel: "MVP simulated content"
    }
  ]
} as const;

describe("ContentBundleSchema", () => {
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
