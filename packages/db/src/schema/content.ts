import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgEnum, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const reviewState = pgEnum("review_state", ["draft", "in_review", "published", "retired"]);

export const sources = pgTable("sources", {
  id: uuid("id").defaultRandom().primaryKey(),
  label: text("label").notNull(),
  reference: text("reference"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [uniqueIndex("sources_label_unique").on(table.label)]);

export const sourceMergeProvenance = pgTable("source_merge_provenance", {
  originalSourceId: uuid("original_source_id").primaryKey(),
  canonicalSourceId: uuid("canonical_source_id").notNull().references(() => sources.id, { onDelete: "restrict" }),
  label: text("label").notNull(),
  reference: text("reference"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const contentBundles = pgTable("content_bundles", {
  bundleId: text("bundle_id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

// Migration-only deferred triggers protect both stable-to-owner and owner-to-stable integrity.
export const contentEntityOwners = pgTable("content_entity_owners", {
  entityType: text("entity_type").notNull(),
  entityKey: text("entity_key").notNull(),
  bundleId: text("bundle_id").notNull().references(() => contentBundles.bundleId, { onDelete: "restrict" })
}, (table) => [
  primaryKey({ name: "content_entity_owners_pk", columns: [table.entityType, table.entityKey] }),
  check("content_entity_owners_type_check", sql`${table.entityType} in ('knowledge', 'question')`)
]);

export const contentBundleVersions = pgTable("content_bundle_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  bundleId: text("bundle_id").notNull().references(() => contentBundles.bundleId, { onDelete: "restrict" }),
  version: integer("version").notNull(),
  payloadHash: text("payload_hash").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [
  uniqueIndex("content_bundle_versions_bundle_version_unique").on(table.bundleId, table.version),
  check("content_bundle_versions_version_check", sql`${table.version} > 0`)
]);

// Stable-key ownership is also guarded by migration-only deferred constraint triggers.
// Drizzle cannot declare those triggers; callers must create the typed owner in the same transaction first.
export const knowledgePoints = pgTable("knowledge_points", {
  id: uuid("id").defaultRandom().primaryKey(),
  canonicalId: text("canonical_id").notNull().unique(),
  name: text("name").notNull(),
  grade: smallint("grade").notNull(),
  semester: smallint("semester").notNull()
}, (table) => [
  check("knowledge_points_grade_check", sql`${table.grade} between 7 and 9`),
  check("knowledge_points_semester_check", sql`${table.semester} in (1, 2)`)
]);

export const knowledgePointVersions = pgTable("knowledge_point_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  knowledgePointId: uuid("knowledge_point_id").notNull().references(() => knowledgePoints.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  name: text("name").notNull(),
  grade: smallint("grade").notNull(),
  semester: smallint("semester").notNull(),
  sourceId: uuid("source_id").references(() => sources.id, { onDelete: "restrict" }),
  reviewState: reviewState("review_state").default("draft").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [
  uniqueIndex("knowledge_point_versions_version_unique").on(table.knowledgePointId, table.version),
  check("knowledge_point_versions_version_check", sql`${table.version} > 0`),
  check("knowledge_point_versions_grade_check", sql`${table.grade} between 7 and 9`),
  check("knowledge_point_versions_semester_check", sql`${table.semester} in (1, 2)`)
]);

export const knowledgePrerequisites = pgTable("knowledge_prerequisites", {
  knowledgePointId: uuid("knowledge_point_id").notNull().references(() => knowledgePoints.id, { onDelete: "cascade" }),
  prerequisiteKnowledgePointId: uuid("prerequisite_knowledge_point_id").notNull().references(() => knowledgePoints.id, { onDelete: "restrict" })
}, (table) => [
  uniqueIndex("knowledge_prerequisites_unique").on(table.knowledgePointId, table.prerequisiteKnowledgePointId),
  check("knowledge_prerequisites_not_self", sql`${table.knowledgePointId} <> ${table.prerequisiteKnowledgePointId}`)
]);

export const questions = pgTable("questions", {
  id: uuid("id").defaultRandom().primaryKey(),
  externalKey: text("external_key").notNull().unique()
});

// Published integrity is enforced by migration triggers and SQL-level tests; Drizzle cannot declare triggers.
export const questionVersions = pgTable("question_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  questionId: uuid("question_id").notNull().references(() => questions.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  stem: text("stem").notNull(),
  answer: text("answer").notNull(),
  explanation: text("explanation").notNull(),
  difficulty: smallint("difficulty"),
  sourceId: uuid("source_id").references(() => sources.id, { onDelete: "restrict" }),
  reviewState: reviewState("review_state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [
  uniqueIndex("question_versions_version_unique").on(table.questionId, table.version),
  check("question_versions_version_check", sql`${table.version} > 0`),
  check("question_versions_difficulty_check", sql`${table.difficulty} between 1 and 5`)
]);

// Keep this stable-question link explicit so the trigger can protect published content on deletion or reassignment.
export const questionKnowledgePoints = pgTable("question_knowledge_points", {
  questionId: uuid("question_id").notNull().references(() => questions.id, { onDelete: "cascade" }),
  knowledgePointId: uuid("knowledge_point_id").notNull().references(() => knowledgePoints.id, { onDelete: "restrict" })
}, (table) => [uniqueIndex("question_knowledge_points_unique").on(table.questionId, table.knowledgePointId)]);
