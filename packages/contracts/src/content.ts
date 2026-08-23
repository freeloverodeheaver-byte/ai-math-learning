import { z } from "zod";

const GradeSchema = z.union([z.literal(7), z.literal(8), z.literal(9)]);
const SemesterSchema = z.union([z.literal(1), z.literal(2)]);
const DifficultySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5)
]);
const NonBlankTextSchema = z.string().trim().min(1);

export const SourceKindSchema = z.enum([
  "simulated",
  "original",
  "licensed",
  "public_domain",
  "ai_generated"
]);

export const LEGACY_CONTENT_BUNDLE_ID = "__legacy_pre_import__";

export const KnowledgePointInputSchema = z.strictObject({
  canonicalId: NonBlankTextSchema,
  name: NonBlankTextSchema,
  grade: GradeSchema,
  semester: SemesterSchema,
  prerequisites: z.array(NonBlankTextSchema)
});

export const QuestionInputSchema = z.strictObject({
  externalKey: NonBlankTextSchema,
  stem: NonBlankTextSchema,
  answer: NonBlankTextSchema,
  explanation: NonBlankTextSchema,
  knowledgeCanonicalIds: z.array(NonBlankTextSchema).min(1),
  difficulty: DifficultySchema,
  sourceLabel: NonBlankTextSchema,
  sourceKind: SourceKindSchema,
  sourceReference: NonBlankTextSchema,
  sourceUsageBasis: NonBlankTextSchema
});

function addDuplicateIssue(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  label: string
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      context.addIssue({ code: "custom", message: `Duplicate ${label}: ${value}`, path });
    }
    seen.add(value);
  }
}

export const ContentBundleSchema = z.strictObject({
  bundleId: NonBlankTextSchema.refine(
    (bundleId) => bundleId !== LEGACY_CONTENT_BUNDLE_ID,
    { message: "Reserved legacy bundle ID" }
  ),
  version: z.number().int().positive(),
  knowledgePoints: z.array(KnowledgePointInputSchema).min(1),
  questions: z.array(QuestionInputSchema).min(1)
}).superRefine((bundle, context) => {
  addDuplicateIssue(
    bundle.knowledgePoints.map((item) => item.canonicalId),
    context,
    ["knowledgePoints"],
    "knowledge canonical ID"
  );
  addDuplicateIssue(
    bundle.questions.map((item) => item.externalKey),
    context,
    ["questions"],
    "question external key"
  );

  const knowledgeIds = new Set(bundle.knowledgePoints.map((item) => item.canonicalId));
  const sourceProvenance = new Map<string, string>();

  for (const [index, question] of bundle.questions.entries()) {
    const fingerprint = JSON.stringify([
      question.sourceKind,
      question.sourceReference,
      question.sourceUsageBasis
    ]);
    const existing = sourceProvenance.get(question.sourceLabel);
    if (existing !== undefined && existing !== fingerprint) {
      context.addIssue({
        code: "custom",
        message: `Conflicting source provenance for label: ${question.sourceLabel}`,
        path: ["questions", index, "sourceLabel"]
      });
    }
    sourceProvenance.set(question.sourceLabel, fingerprint);
  }

  for (const [index, point] of bundle.knowledgePoints.entries()) {
    addDuplicateIssue(
      point.prerequisites,
      context,
      ["knowledgePoints", index, "prerequisites"],
      "prerequisite ID"
    );
    for (const prerequisiteId of point.prerequisites) {
      if (!knowledgeIds.has(prerequisiteId)) {
        context.addIssue({
          code: "custom",
          message: `Unknown knowledge point: ${prerequisiteId}`,
          path: ["knowledgePoints", index, "prerequisites"]
        });
      }
    }
  }

  for (const [index, question] of bundle.questions.entries()) {
    addDuplicateIssue(
      question.knowledgeCanonicalIds,
      context,
      ["questions", index, "knowledgeCanonicalIds"],
      "question knowledge ID"
    );
    for (const knowledgeId of question.knowledgeCanonicalIds) {
      if (!knowledgeIds.has(knowledgeId)) {
        context.addIssue({
          code: "custom",
          message: `Unknown knowledge point: ${knowledgeId}`,
          path: ["questions", index, "knowledgeCanonicalIds"]
        });
      }
    }
  }
});

export type KnowledgePointInput = z.infer<typeof KnowledgePointInputSchema>;
export type SourceKind = z.infer<typeof SourceKindSchema>;
export type QuestionInput = z.infer<typeof QuestionInputSchema>;
export type ContentBundle = z.infer<typeof ContentBundleSchema>;
