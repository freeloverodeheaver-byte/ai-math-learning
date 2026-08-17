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

export const KnowledgePointInputSchema = z.strictObject({
  canonicalId: z.string().min(1),
  name: z.string().min(1),
  grade: GradeSchema,
  semester: SemesterSchema,
  prerequisites: z.array(z.string().min(1))
});

export const QuestionInputSchema = z.strictObject({
  externalKey: z.string().min(1),
  stem: z.string().min(1),
  answer: z.string().min(1),
  explanation: z.string().min(1),
  knowledgeCanonicalIds: z.array(z.string().min(1)),
  difficulty: DifficultySchema,
  sourceLabel: z.string().min(1)
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
  bundleId: z.string().min(1),
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
export type QuestionInput = z.infer<typeof QuestionInputSchema>;
export type ContentBundle = z.infer<typeof ContentBundleSchema>;
