import { createHash } from "node:crypto";
import {
  ContentBundleSchema,
  type Actor,
  type ContentBundle,
  type KnowledgePointInput,
  type QuestionInput
} from "@math/contracts";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  ContentRepository,
  type ContentEntityOwner,
  type ContentTransaction,
  type StableKnowledgeState,
  type StableQuestionState
} from "./repository.js";

export interface ImportResult {
  createdKnowledge: number;
  createdQuestions: number;
  newVersions: number;
  unchanged: number;
}

type TransactionHost = PgDatabase<any, any, any>;

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareOwners(left: ContentEntityOwner, right: ContentEntityOwner): number {
  const typeOrder = compareStrings(left.entityType, right.entityType);
  return typeOrder === 0 ? compareStrings(left.entityKey, right.entityKey) : typeOrder;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort(compareStrings);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = sorted(left);
  const sortedRight = sorted(right);
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function canonicalPayload(bundle: ContentBundle): string {
  return JSON.stringify({
    bundleId: bundle.bundleId,
    version: bundle.version,
    knowledgePoints: bundle.knowledgePoints
      .map((point) => ({
        canonicalId: point.canonicalId,
        name: point.name,
        grade: point.grade,
        semester: point.semester,
        prerequisites: sorted(point.prerequisites)
      }))
      .sort((left, right) => compareStrings(left.canonicalId, right.canonicalId)),
    questions: bundle.questions
      .map((question) => ({
        externalKey: question.externalKey,
        stem: question.stem,
        answer: question.answer,
        explanation: question.explanation,
        knowledgeCanonicalIds: sorted(question.knowledgeCanonicalIds),
        difficulty: question.difficulty,
        sourceLabel: question.sourceLabel
      }))
      .sort((left, right) => compareStrings(left.externalKey, right.externalKey))
  });
}

function payloadHash(bundle: ContentBundle): string {
  return createHash("sha256").update(canonicalPayload(bundle)).digest("hex");
}

function knowledgeChanged(input: KnowledgePointInput, state: StableKnowledgeState): boolean {
  return state.latest === undefined
    || state.latest.name !== input.name
    || state.latest.grade !== input.grade
    || state.latest.semester !== input.semester
    || !sameStrings(state.latest.prerequisiteCanonicalIds, input.prerequisites);
}

function questionChanged(input: QuestionInput, state: StableQuestionState): boolean {
  return state.latest === undefined
    || state.latest.stem !== input.stem
    || state.latest.answer !== input.answer
    || state.latest.explanation !== input.explanation
    || state.latest.difficulty !== input.difficulty
    || state.latest.sourceLabel !== input.sourceLabel
    || !sameStrings(state.latest.knowledgeCanonicalIds, input.knowledgeCanonicalIds);
}

export class ContentService {
  constructor(
    private readonly database: TransactionHost,
    private readonly repository: ContentRepository
  ) {}

  async importBundle(
    bundle: ContentBundle,
    _actor: Actor,
    transaction?: ContentTransaction
  ): Promise<ImportResult> {
    const parsed = ContentBundleSchema.parse(bundle);
    const run = (activeTransaction: ContentTransaction) => this.importInTransaction(parsed, activeTransaction);
    return transaction === undefined ? this.database.transaction(run) : run(transaction);
  }

  private async importInTransaction(
    bundle: ContentBundle,
    transaction: ContentTransaction
  ): Promise<ImportResult> {
    const hash = payloadHash(bundle);
    await this.repository.lockBundle(transaction, bundle.bundleId);
    const tracking = await this.repository.findBundleVersion(transaction, bundle.bundleId, bundle.version);

    if (tracking.latestVersion !== undefined && bundle.version < tracking.latestVersion) {
      throw new Error(`Bundle version ${bundle.version} is lower than latest version ${tracking.latestVersion}`);
    }
    if (tracking.existing !== undefined) {
      if (tracking.existing.payloadHash !== hash) {
        throw new Error(`Bundle ${bundle.bundleId} version ${bundle.version} has a different payload`);
      }
      return {
        createdKnowledge: 0,
        createdQuestions: 0,
        newVersions: 0,
        unchanged: bundle.knowledgePoints.length + bundle.questions.length
      };
    }

    // Reserve the revision while the bundle row is locked. Any later failure rolls this row back with the import.
    await this.repository.recordBundleVersion(transaction, bundle.bundleId, bundle.version, hash);

    // The deterministic global order prevents overlapping bundles from acquiring owner locks in opposite orders.
    const owners: ContentEntityOwner[] = [
      ...bundle.knowledgePoints.map((point) => ({
        entityType: "knowledge" as const,
        entityKey: point.canonicalId
      })),
      ...bundle.questions.map((question) => ({
        entityType: "question" as const,
        entityKey: question.externalKey
      }))
    ].sort(compareOwners);
    for (const owner of owners) {
      await this.repository.lockEntityOwner(transaction, bundle.bundleId, owner);
    }

    const result: ImportResult = {
      createdKnowledge: 0,
      createdQuestions: 0,
      newVersions: 0,
      unchanged: 0
    };
    const stableKnowledge = new Map<string, StableKnowledgeState>();

    for (const point of bundle.knowledgePoints) {
      stableKnowledge.set(
        point.canonicalId,
        await this.repository.upsertStableKnowledgePoint(transaction, point)
      );
    }

    for (const point of bundle.knowledgePoints) {
      const state = stableKnowledge.get(point.canonicalId)!;
      if (!knowledgeChanged(point, state)) {
        result.unchanged += 1;
        continue;
      }
      await this.repository.appendKnowledgeVersion(transaction, state.id, bundle.version, point);
      await this.repository.replaceKnowledgePrerequisites(
        transaction,
        state.id,
        point.prerequisites.map((canonicalId) => stableKnowledge.get(canonicalId)!.id)
      );
      if (state.created) result.createdKnowledge += 1;
      else result.newVersions += 1;
    }

    for (const question of bundle.questions) {
      const sourceId = await this.repository.upsertSource(transaction, question.sourceLabel);
      const state = await this.repository.upsertStableQuestion(transaction, question);
      if (!questionChanged(question, state)) {
        result.unchanged += 1;
        continue;
      }
      await this.repository.appendQuestionVersion(transaction, state.id, bundle.version, question, sourceId);
      await this.repository.replaceQuestionKnowledgeLinks(
        transaction,
        state.id,
        question.knowledgeCanonicalIds.map((canonicalId) => stableKnowledge.get(canonicalId)!.id)
      );
      if (state.created) result.createdQuestions += 1;
      else result.newVersions += 1;
    }

    return result;
  }
}
