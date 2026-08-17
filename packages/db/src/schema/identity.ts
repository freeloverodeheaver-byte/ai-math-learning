import { sql } from "drizzle-orm";
import { check, pgEnum, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const appRole = pgEnum("app_role", ["student", "guardian", "teacher", "operator"]);
export const membershipState = pgEnum("membership_state", ["requested", "active", "rejected", "revoked"]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  externalSubject: text("external_subject").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const userRoles = pgTable("user_roles", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: appRole("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [uniqueIndex("user_roles_user_role_unique").on(table.userId, table.role)]);

export const studentProfiles = pgTable("student_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  grade: smallint("grade").notNull(),
  semester: smallint("semester").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (table) => [
  check("student_profiles_grade_check", sql`${table.grade} between 7 and 9`),
  check("student_profiles_semester_check", sql`${table.semester} in (1, 2)`)
]);

export const guardianLinks = pgTable("guardian_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  guardianUserId: uuid("guardian_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  studentProfileId: uuid("student_profile_id").notNull().references(() => studentProfiles.id, { onDelete: "cascade" }),
  linkedAt: timestamp("linked_at", { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true })
}, (table) => [
  uniqueIndex("guardian_links_active_unique").on(table.guardianUserId, table.studentProfileId).where(sql`${table.revokedAt} is null`)
]);

export const teacherProfiles = pgTable("teacher_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

// Migration 0002 prevents changing class ownership while an active membership
// still has an unrevoked grant; ownership transfer must revoke grants first.
export const classes = pgTable("classes", {
  id: uuid("id").defaultRandom().primaryKey(),
  teacherProfileId: uuid("teacher_profile_id").notNull().references(() => teacherProfiles.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  inviteCode: text("invite_code").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

// Migration 0002 prevents rebinding class/student identity while an unrevoked
// grant exists. Grant revocation and any rebinding must share one transaction.
export const classMemberships = pgTable("class_memberships", {
  id: uuid("id").defaultRandom().primaryKey(),
  classId: uuid("class_id").notNull().references(() => classes.id, { onDelete: "cascade" }),
  studentProfileId: uuid("student_profile_id").notNull().references(() => studentProfiles.id, { onDelete: "cascade" }),
  state: membershipState("state").default("requested").notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true })
}, (table) => [
  uniqueIndex("class_memberships_open_unique")
    .on(table.classId, table.studentProfileId)
    .where(sql`${table.state} in ('requested', 'active')`),
  check(
    "class_memberships_state_resolved_check",
    sql`(${table.state} = 'requested' and ${table.resolvedAt} is null)
      or (${table.state} in ('active', 'rejected', 'revoked') and ${table.resolvedAt} is not null)`
  )
]);

// Migration 0002 also installs deferred cross-table integrity triggers. Drizzle
// cannot express those triggers: an unrevoked grant requires this membership to
// be active and to reference the same student, and leaving active requires every
// grant to be revoked in the same transaction.
export const dataSharingGrants = pgTable("data_sharing_grants", {
  id: uuid("id").defaultRandom().primaryKey(),
  classMembershipId: uuid("class_membership_id").notNull().references(() => classMemberships.id, { onDelete: "cascade" }),
  studentProfileId: uuid("student_profile_id").notNull().references(() => studentProfiles.id, { onDelete: "cascade" }),
  scope: text("scope").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true })
}, (table) => [
  uniqueIndex("data_sharing_grants_active_unique").on(table.classMembershipId, table.scope).where(sql`${table.revokedAt} is null`),
  check(
    "data_sharing_grants_scope_check",
    sql`${table.revokedAt} is not null or ${table.scope} in ('learning_summary', 'shared_personal_content')`
  )
]);
