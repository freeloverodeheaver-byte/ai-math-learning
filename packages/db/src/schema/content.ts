import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgEnum, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const reviewState = pgEnum("review_state", ["draft", "in_review", "published", "retired"]);

export const sources = pgTable("sources", {
  id: uuid("id").defaultRandom().primaryKey(),
  label: text("label").notNull(),
  reference: text("reference"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

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
}, (table) => [uniqueIndex("knowledge_prerequisites_unique").on(table.knowledgePointId, table.prerequisiteKnowledgePointId)]);

export const questions = pgTable("questions", {
  id: uuid("id").defaultRandom().primaryKey(),
  externalKey: text("external_key").notNull().unique()
});

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

export const questionKnowledgePoints = pgTable("question_knowledge_points", {
  questionId: uuid("question_id").notNull().references(() => questions.id, { onDelete: "cascade" }),
  knowledgePointId: uuid("knowledge_point_id").notNull().references(() => knowledgePoints.id, { onDelete: "restrict" })
}, (table) => [uniqueIndex("question_knowledge_points_unique").on(table.questionId, table.knowledgePointId)]);
