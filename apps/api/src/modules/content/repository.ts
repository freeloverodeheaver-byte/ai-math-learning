import {
  SourceKindSchema,
  type ContentBundle,
  type KnowledgePointInput,
  type QuestionInput,
} from "@math/contracts";
import {
  contentBundles,
  contentBundleVersions,
  contentEntityOwners,
  knowledgePointVersions,
  knowledgePoints,
  knowledgePrerequisites,
  questionKnowledgePoints,
  questionVersions,
  questions,
  sources
} from "@math/db";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { alias } from "drizzle-orm/pg-core";

export type ContentTransaction = Pick<
  PgDatabase<PgQueryResultHKT>,
  "select" | "insert" | "update" | "delete"
>;

export interface BundleVersionState {
  existing: { payloadHash: string } | undefined;
  latestVersion: number | undefined;
}

export type ContentEntityOwner = {
  entityType: "knowledge" | "question";
  entityKey: string;
};

export interface StableKnowledgeState {
  id: string;
  created: boolean;
  latest: {
    version: number;
    name: string;
    grade: number;
    semester: number;
    prerequisiteCanonicalIds: string[];
  } | undefined;
}

export interface StableQuestionState {
  id: string;
  created: boolean;
  latest: {
    version: number;
    stem: string;
    answer: string;
    explanation: string;
    difficulty: number | null;
    sourceLabel: string | null;
    sourceKind: QuestionInput["sourceKind"] | null;
    sourceReference: string | null;
    sourceUsageBasis: string | null;
    knowledgeCanonicalIds: string[];
  } | undefined;
}

export interface PublicationResult {
  knowledgePoints: number;
  questions: number;
}

export interface PublishedQuestion {
  externalKey: string;
  version: number;
  stem: string;
  answer: string;
  explanation: string;
  difficulty: number | null;
}

export class IncompletePublicationError extends Error {
  constructor(entityType: "knowledge" | "question", entityKey: string, version: number) {
    super(`No effective ${entityType} version for ${entityKey} at bundle version ${version}`);
    this.name = "IncompletePublicationError";
  }
}

export interface SourceProvenanceInput {
  label: string;
  kind: QuestionInput["sourceKind"];
  reference: string;
  usageBasis: string;
}

export class SourceProvenanceConflictError extends Error {
  readonly code = "SOURCE_PROVENANCE_CONFLICT";
  readonly statusCode = 409;

  constructor(label: string) {
    super(`Source provenance conflict for label: ${label}`);
    this.name = "SourceProvenanceConflictError";
  }
}

export class ContentRepository {
  async listLatestPublishedQuestions(
    transaction: ContentTransaction,
  ): Promise<PublishedQuestion[]> {
    const rows = await transaction
      .select({
        externalKey: questions.externalKey,
        version: questionVersions.version,
        stem: questionVersions.stem,
        answer: questionVersions.answer,
        explanation: questionVersions.explanation,
        difficulty: questionVersions.difficulty,
      })
      .from(questionVersions)
      .innerJoin(questions, eq(questionVersions.questionId, questions.id))
      .where(eq(questionVersions.reviewState, "published"))
      .orderBy(asc(questions.externalKey), desc(questionVersions.version));

    const latest: PublishedQuestion[] = [];
    for (const row of rows) {
      if (latest.at(-1)?.externalKey !== row.externalKey) latest.push(row);
    }
    return latest;
  }

  async publishBundleRevision(
    transaction: ContentTransaction,
    bundle: ContentBundle
  ): Promise<PublicationResult> {
    for (const point of bundle.knowledgePoints) {
      const [effective] = await transaction
        .select({ id: knowledgePointVersions.id })
        .from(knowledgePointVersions)
        .innerJoin(knowledgePoints, eq(knowledgePointVersions.knowledgePointId, knowledgePoints.id))
        .innerJoin(contentEntityOwners, and(
          eq(contentEntityOwners.entityType, "knowledge"),
          eq(contentEntityOwners.entityKey, knowledgePoints.canonicalId)
        ))
        .where(and(
          eq(contentEntityOwners.bundleId, bundle.bundleId),
          eq(knowledgePoints.canonicalId, point.canonicalId),
          lte(knowledgePointVersions.version, bundle.version)
        ))
        .orderBy(desc(knowledgePointVersions.version))
        .limit(1);
      if (effective === undefined) {
        throw new IncompletePublicationError("knowledge", point.canonicalId, bundle.version);
      }
      const published = await transaction.update(knowledgePointVersions)
        .set({ reviewState: "published" })
        .where(eq(knowledgePointVersions.id, effective.id))
        .returning({ id: knowledgePointVersions.id });
      if (published.length !== 1) {
        throw new IncompletePublicationError("knowledge", point.canonicalId, bundle.version);
      }
    }

    for (const question of bundle.questions) {
      const [effective] = await transaction
        .select({ id: questionVersions.id })
        .from(questionVersions)
        .innerJoin(questions, eq(questionVersions.questionId, questions.id))
        .innerJoin(contentEntityOwners, and(
          eq(contentEntityOwners.entityType, "question"),
          eq(contentEntityOwners.entityKey, questions.externalKey)
        ))
        .where(and(
          eq(contentEntityOwners.bundleId, bundle.bundleId),
          eq(questions.externalKey, question.externalKey),
          lte(questionVersions.version, bundle.version)
        ))
        .orderBy(desc(questionVersions.version))
        .limit(1);
      if (effective === undefined) {
        throw new IncompletePublicationError("question", question.externalKey, bundle.version);
      }
      const published = await transaction.update(questionVersions)
        .set({ reviewState: "published" })
        .where(eq(questionVersions.id, effective.id))
        .returning({ id: questionVersions.id });
      if (published.length !== 1) {
        throw new IncompletePublicationError("question", question.externalKey, bundle.version);
      }
    }

    return {
      knowledgePoints: bundle.knowledgePoints.length,
      questions: bundle.questions.length
    };
  }

  async lockBundle(transaction: ContentTransaction, bundleId: string): Promise<void> {
    await transaction
      .insert(contentBundles)
      .values({ bundleId })
      .onConflictDoNothing({ target: contentBundles.bundleId });

    const [locked] = await transaction
      .select({ bundleId: contentBundles.bundleId })
      .from(contentBundles)
      .where(eq(contentBundles.bundleId, bundleId))
      .for("update");
    if (locked === undefined) throw new Error(`Unable to lock bundle ${bundleId}`);
  }

  async lockEntityOwner(
    transaction: ContentTransaction,
    bundleId: string,
    owner: ContentEntityOwner
  ): Promise<void> {
    await transaction
      .insert(contentEntityOwners)
      .values({ ...owner, bundleId })
      .onConflictDoNothing({ target: [contentEntityOwners.entityType, contentEntityOwners.entityKey] });

    const [locked] = await transaction
      .select({ bundleId: contentEntityOwners.bundleId })
      .from(contentEntityOwners)
      .where(and(
        eq(contentEntityOwners.entityType, owner.entityType),
        eq(contentEntityOwners.entityKey, owner.entityKey)
      ))
      .for("update");

    if (locked === undefined) {
      throw new Error(`Unable to lock ${owner.entityType} ${owner.entityKey}`);
    }
    if (locked.bundleId !== bundleId) {
      throw new Error(`${owner.entityType} ${owner.entityKey} is owned by bundle ${locked.bundleId}`);
    }
  }

  async findBundleVersion(
    transaction: ContentTransaction,
    bundleId: string,
    version: number
  ): Promise<BundleVersionState> {
    const rows = await transaction
      .select({ version: contentBundleVersions.version, payloadHash: contentBundleVersions.payloadHash })
      .from(contentBundleVersions)
      .where(eq(contentBundleVersions.bundleId, bundleId))
      .orderBy(desc(contentBundleVersions.version));

    if (rows.length === 0) return { existing: undefined, latestVersion: undefined };

    return {
      existing: rows.find((row) => row.version === version),
      latestVersion: rows[0]?.version
    };
  }

  async recordBundleVersion(
    transaction: ContentTransaction,
    bundleId: string,
    version: number,
    payloadHash: string
  ): Promise<void> {
    await transaction.insert(contentBundleVersions).values({ bundleId, version, payloadHash });
  }

  async upsertSource(
    transaction: ContentTransaction,
    input: SourceProvenanceInput
  ): Promise<string> {
    const [inserted] = await transaction
      .insert(sources)
      .values({
        label: input.label,
        reference: input.reference,
        metadata: { kind: input.kind, usageBasis: input.usageBasis }
      })
      .onConflictDoNothing({ target: sources.label })
      .returning({ id: sources.id });
    if (inserted !== undefined) return inserted.id;

    const [existing] = await transaction.select({
      id: sources.id,
      reference: sources.reference,
      metadata: sources.metadata
    }).from(sources).where(eq(sources.label, input.label));
    if (
      existing === undefined ||
      existing.reference !== input.reference ||
      existing.metadata.kind !== input.kind ||
      existing.metadata.usageBasis !== input.usageBasis
    ) {
      throw new SourceProvenanceConflictError(input.label);
    }
    return existing.id;
  }

  async upsertStableKnowledgePoint(
    transaction: ContentTransaction,
    input: KnowledgePointInput
  ): Promise<StableKnowledgeState> {
    // ContentService holds this canonical ID's durable owner row lock, so this select/insert cannot race.
    const [existing] = await transaction
      .select({ id: knowledgePoints.id })
      .from(knowledgePoints)
      .where(eq(knowledgePoints.canonicalId, input.canonicalId));

    let id: string;
    let created = false;
    if (existing === undefined) {
      const [inserted] = await transaction
        .insert(knowledgePoints)
        .values({
          canonicalId: input.canonicalId,
          name: input.name,
          grade: input.grade,
          semester: input.semester
        })
        .returning({ id: knowledgePoints.id });
      id = inserted!.id;
      created = true;
    } else {
      const [updated] = await transaction
        .update(knowledgePoints)
        .set({ name: input.name, grade: input.grade, semester: input.semester })
        .where(eq(knowledgePoints.id, existing.id))
        .returning({ id: knowledgePoints.id });
      id = updated!.id;
    }

    const [latestVersion] = await transaction
      .select({
        version: knowledgePointVersions.version,
        name: knowledgePointVersions.name,
        grade: knowledgePointVersions.grade,
        semester: knowledgePointVersions.semester
      })
      .from(knowledgePointVersions)
      .where(eq(knowledgePointVersions.knowledgePointId, id))
      .orderBy(desc(knowledgePointVersions.version))
      .limit(1);

    if (latestVersion === undefined) return { id, created, latest: undefined };

    const prerequisitePoint = alias(knowledgePoints, "prerequisite_point");
    const prerequisiteRows = await transaction
      .select({ canonicalId: prerequisitePoint.canonicalId })
      .from(knowledgePrerequisites)
      .innerJoin(
        prerequisitePoint,
        eq(knowledgePrerequisites.prerequisiteKnowledgePointId, prerequisitePoint.id)
      )
      .where(eq(knowledgePrerequisites.knowledgePointId, id));

    return {
      id,
      created,
      latest: {
        ...latestVersion,
        prerequisiteCanonicalIds: prerequisiteRows.map((row) => row.canonicalId)
      }
    };
  }

  async upsertStableQuestion(
    transaction: ContentTransaction,
    input: QuestionInput
  ): Promise<StableQuestionState> {
    // ContentService holds this external key's durable owner row lock, so this select/insert cannot race.
    const [existing] = await transaction
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.externalKey, input.externalKey));

    let id: string;
    let created = false;
    if (existing === undefined) {
      const [inserted] = await transaction
        .insert(questions)
        .values({ externalKey: input.externalKey })
        .returning({ id: questions.id });
      id = inserted!.id;
      created = true;
    } else {
      id = existing.id;
    }

    const [latestVersion] = await transaction
      .select({
        version: questionVersions.version,
        stem: questionVersions.stem,
        answer: questionVersions.answer,
        explanation: questionVersions.explanation,
        difficulty: questionVersions.difficulty,
        sourceLabel: sources.label,
        sourceReference: sources.reference,
        sourceMetadata: sources.metadata
      })
      .from(questionVersions)
      .leftJoin(sources, eq(questionVersions.sourceId, sources.id))
      .where(eq(questionVersions.questionId, id))
      .orderBy(desc(questionVersions.version))
      .limit(1);

    if (latestVersion === undefined) return { id, created, latest: undefined };
    const sourceKind = SourceKindSchema.safeParse(latestVersion.sourceMetadata?.kind);

    const linkRows = await transaction
      .select({ canonicalId: knowledgePoints.canonicalId })
      .from(questionKnowledgePoints)
      .innerJoin(knowledgePoints, eq(questionKnowledgePoints.knowledgePointId, knowledgePoints.id))
      .where(eq(questionKnowledgePoints.questionId, id));

    return {
      id,
      created,
      latest: {
        version: latestVersion.version,
        stem: latestVersion.stem,
        answer: latestVersion.answer,
        explanation: latestVersion.explanation,
        difficulty: latestVersion.difficulty,
        sourceLabel: latestVersion.sourceLabel,
        sourceKind: sourceKind.success ? sourceKind.data : null,
        sourceReference: latestVersion.sourceReference,
        sourceUsageBasis: typeof latestVersion.sourceMetadata?.usageBasis === "string"
          ? latestVersion.sourceMetadata.usageBasis
          : null,
        knowledgeCanonicalIds: linkRows.map((row) => row.canonicalId)
      }
    };
  }

  async appendKnowledgeVersion(
    transaction: ContentTransaction,
    knowledgePointId: string,
    version: number,
    input: KnowledgePointInput
  ): Promise<void> {
    await transaction.insert(knowledgePointVersions).values({
      knowledgePointId,
      version,
      name: input.name,
      grade: input.grade,
      semester: input.semester,
      reviewState: "draft"
    });
  }

  async replaceKnowledgePrerequisites(
    transaction: ContentTransaction,
    knowledgePointId: string,
    prerequisiteKnowledgePointIds: readonly string[]
  ): Promise<void> {
    await transaction
      .delete(knowledgePrerequisites)
      .where(eq(knowledgePrerequisites.knowledgePointId, knowledgePointId));
    if (prerequisiteKnowledgePointIds.length > 0) {
      await transaction.insert(knowledgePrerequisites).values(
        prerequisiteKnowledgePointIds.map((prerequisiteKnowledgePointId) => ({
          knowledgePointId,
          prerequisiteKnowledgePointId
        }))
      );
    }
  }

  async appendQuestionVersion(
    transaction: ContentTransaction,
    questionId: string,
    version: number,
    input: QuestionInput,
    sourceId: string
  ): Promise<void> {
    await transaction.insert(questionVersions).values({
      questionId,
      version,
      stem: input.stem,
      answer: input.answer,
      explanation: input.explanation,
      difficulty: input.difficulty,
      sourceId,
      reviewState: "draft"
    });
  }

  async replaceQuestionKnowledgeLinks(
    transaction: ContentTransaction,
    questionId: string,
    knowledgePointIds: readonly string[]
  ): Promise<void> {
    await transaction.delete(questionKnowledgePoints).where(eq(questionKnowledgePoints.questionId, questionId));
    if (knowledgePointIds.length > 0) {
      await transaction.insert(questionKnowledgePoints).values(
        knowledgePointIds.map((knowledgePointId) => ({ questionId, knowledgePointId }))
      );
    }
  }
}
