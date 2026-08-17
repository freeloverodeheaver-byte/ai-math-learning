import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { Actor, Role } from "@math/contracts";
import {
  auditEvents,
  classes,
  classMemberships,
  dataSharingGrants,
  guardianLinks,
  studentProfiles,
  teacherProfiles,
  userRoles,
  users,
} from "@math/db";
import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { DevIdentityProvider } from "../src/modules/identity/dev-identity-provider.js";
import {
  decideStudentRead,
  type AccessDecisionRepository,
  type SharingScope,
} from "../src/modules/access/policy.js";
import {
  AccessRepository,
  type AccessTransaction,
  type ClassCreatedAuditMetadata,
  type ClassMembership,
  type StudentCreatedAuditMetadata,
} from "../src/modules/access/repository.js";
import { registerAccessRoutes } from "../src/modules/access/routes.js";
import { AccessService } from "../src/modules/access/service.js";
import { registerActorPlugin } from "../src/plugins/actor.js";

const studentId = "10000000-0000-4000-8000-000000000001";
const missingStudentId = "10000000-0000-4000-8000-000000000099";

const actors = {
  student: { userId: "student-user", roles: ["student"] },
  linkedGuardian: { userId: "linked-guardian", roles: ["guardian"] },
  revokedGuardian: { userId: "revoked-guardian", roles: ["guardian"] },
  approvedTeacher: { userId: "approved-teacher", roles: ["teacher"] },
  revokedGrantTeacher: { userId: "revoked-grant-teacher", roles: ["teacher"] },
  inactiveMembershipTeacher: { userId: "inactive-membership-teacher", roles: ["teacher"] },
  unrelatedTeacher: { userId: "unrelated-teacher", roles: ["teacher"] },
  unrelatedGuardian: { userId: "unrelated-guardian", roles: ["guardian"] },
  operator: { userId: "operator", roles: ["operator"] },
} satisfies Record<string, Actor>;

const repository: AccessDecisionRepository = {
  isStudentUser: async (actorUserId, targetStudentId) =>
    actorUserId === actors.student.userId && targetStudentId === studentId,
  hasActiveGuardianLink: async (actorUserId, targetStudentId) =>
    actorUserId === actors.linkedGuardian.userId && targetStudentId === studentId,
  hasActiveClassGrant: async (actorUserId, targetStudentId, scope) =>
    actorUserId === actors.approvedTeacher.userId &&
    targetStudentId === studentId &&
    scope === "learning_summary",
};

describe("student read policy", () => {
  it.each([
    ["student self", actors.student, studentId, "learning_summary", true, "self"],
    ["active guardian", actors.linkedGuardian, studentId, "learning_summary", true, "guardian_link"],
    ["guardian link without guardian role", { userId: actors.linkedGuardian.userId, roles: [] }, studentId, "learning_summary", false, "not_authorized"],
    ["revoked guardian", actors.revokedGuardian, studentId, "learning_summary", false, "not_authorized"],
    ["approved teacher exact scope", actors.approvedTeacher, studentId, "learning_summary", true, "class_grant"],
    ["class grant without teacher role", { userId: actors.approvedTeacher.userId, roles: ["guardian"] }, studentId, "learning_summary", false, "not_authorized"],
    ["approved teacher wrong scope", actors.approvedTeacher, studentId, "shared_personal_content", false, "not_authorized"],
    ["teacher with revoked grant", actors.revokedGrantTeacher, studentId, "learning_summary", false, "not_authorized"],
    ["teacher with inactive membership", actors.inactiveMembershipTeacher, studentId, "learning_summary", false, "not_authorized"],
    ["unrelated teacher", actors.unrelatedTeacher, studentId, "learning_summary", false, "not_authorized"],
    ["unrelated guardian", actors.unrelatedGuardian, studentId, "learning_summary", false, "not_authorized"],
    ["operator", actors.operator, studentId, "shared_personal_content", true, "operator"],
    ["missing student", actors.student, missingStudentId, "learning_summary", false, "not_authorized"],
  ] as const)("%s", async (_name, actor, target, scope, allowed, reason) => {
    await expect(decideStudentRead(repository, actor, target, scope)).resolves.toEqual({
      allowed,
      reason,
    });
  });
});

const accessSchema = {
  auditEvents,
  classes,
  classMemberships,
  dataSharingGrants,
  guardianLinks,
  studentProfiles,
  teacherProfiles,
  userRoles,
  users,
};
const integrationPglite = await PGlite.create({ extensions: { pgcrypto } });
const integrationDb = drizzle(integrationPglite, { schema: accessSchema });
const integrationRepository = new AccessRepository(integrationDb);
const integrationService = new AccessService(
  integrationDb,
  integrationRepository,
  () => `invite-${randomUUID()}`,
);

beforeAll(async () => {
  const migrations = new URL("../../../packages/db/migrations/", import.meta.url);
  const journal = JSON.parse(
    await readFile(new URL("meta/_journal.json", migrations), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  for (const entry of journal.entries) {
    await integrationPglite.exec(
      await readFile(new URL(`${entry.tag}.sql`, migrations), "utf8"),
    );
  }
});

afterAll(async () => {
  await integrationPglite.close();
});

async function seedActor(
  roles: readonly Role[],
  options: { teacherProfile?: boolean } = {},
): Promise<Actor> {
  const userId = randomUUID();
  await integrationDb.insert(users).values({
    id: userId,
    externalSubject: `actor-${userId}`,
  });
  await integrationDb.insert(userRoles).values(
    roles.map((role) => ({ userId, role })),
  );
  if (options.teacherProfile) {
    await integrationDb.insert(teacherProfiles).values({
      userId,
      displayName: `Teacher ${userId}`,
    });
  }
  return { userId, roles };
}

async function createRequestedMembership() {
  const guardian = await seedActor(["guardian"]);
  const teacher = await seedActor(["teacher"], { teacherProfile: true });
  const student = await integrationService.createStudentForGuardian(guardian, {
    studentExternalSubject: `transition-child-${randomUUID()}`,
    displayName: "Transition child",
    grade: 9,
    semester: 2,
  });
  const createdClass = await integrationService.createClass(teacher, {
    name: `Transition class ${randomUUID()}`,
    subject: "math",
  });
  const membership = await integrationService.requestClassMembership(
    guardian,
    createdClass.inviteCode,
    student.id,
  );
  return { guardian, teacher, student, createdClass, membership };
}

describe("family and class setup service", () => {
  it("creates a child user, student role, profile, and active guardian link atomically", async () => {
    const guardian = await seedActor(["guardian"]);
    const externalSubject = `child-${randomUUID()}`;

    const student = await integrationService.createStudentForGuardian(guardian, {
      studentExternalSubject: externalSubject,
      displayName: "小明",
      grade: 7,
      semester: 1,
    });

    expect(student).toMatchObject({ displayName: "小明", grade: 7, semester: 1 });
    const [role] = await integrationDb
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(and(eq(userRoles.userId, student.userId), eq(userRoles.role, "student")));
    const [link] = await integrationDb
      .select({ guardianUserId: guardianLinks.guardianUserId, revokedAt: guardianLinks.revokedAt })
      .from(guardianLinks)
      .where(eq(guardianLinks.studentProfileId, student.id));
    expect(role).toEqual({ role: "student" });
    expect(link).toEqual({ guardianUserId: guardian.userId, revokedAt: null });

    await expect(integrationService.createStudentForGuardian(guardian, {
      studentExternalSubject: externalSubject,
      displayName: "Duplicate",
      grade: 8,
      semester: 2,
    })).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT", message: "CONFLICT" });

    const [matchingUsers] = await integrationDb
      .select({ value: count() })
      .from(users)
      .where(eq(users.externalSubject, externalSubject));
    expect(matchingUsers?.value).toBe(1);
  });

  it("requires guardian role before creating a student", async () => {
    const teacher = await seedActor(["teacher"], { teacherProfile: true });

    await expect(integrationService.createStudentForGuardian(teacher, {
      studentExternalSubject: `denied-child-${randomUUID()}`,
      displayName: "Denied",
      grade: 7,
      semester: 1,
    })).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });

  it("creates a math class with an internally generated invite for an existing teacher profile", async () => {
    const teacher = await seedActor(["teacher"], { teacherProfile: true });

    const createdClass = await integrationService.createClass(teacher, {
      name: "七年级一班",
      subject: "math",
    });

    expect(createdClass).toMatchObject({
      name: "七年级一班",
      subject: "math",
    });
    expect(createdClass.inviteCode).toMatch(/^invite-/);

    const teacherWithoutProfile = await seedActor(["teacher"]);
    await expect(integrationService.createClass(teacherWithoutProfile, {
      name: "No profile",
      subject: "math",
    })).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });

  it("lets the student self or an active guardian request membership and audits null to requested", async () => {
    const guardian = await seedActor(["guardian"]);
    const teacher = await seedActor(["teacher"], { teacherProfile: true });
    const unrelatedGuardian = await seedActor(["guardian"]);
    const student = await integrationService.createStudentForGuardian(guardian, {
      studentExternalSubject: `request-child-${randomUUID()}`,
      displayName: "Request child",
      grade: 8,
      semester: 1,
    });
    const guardianClass = await integrationService.createClass(teacher, {
      name: "Guardian request",
      subject: "math",
    });

    await expect(integrationService.requestClassMembership(
      unrelatedGuardian,
      guardianClass.inviteCode,
      student.id,
    )).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    const guardianRequest = await integrationService.requestClassMembership(
      guardian,
      guardianClass.inviteCode,
      student.id,
    );
    expect(guardianRequest).toMatchObject({
      classId: guardianClass.id,
      studentProfileId: student.id,
      state: "requested",
      resolvedAt: null,
    });

    const selfClass = await integrationService.createClass(teacher, {
      name: "Self request",
      subject: "math",
    });
    const selfRequest = await integrationService.requestClassMembership(
      { userId: student.userId, roles: ["student"] },
      selfClass.inviteCode,
      student.id,
    );
    expect(selfRequest.state).toBe("requested");

    const [audit] = await integrationDb
      .select({ action: auditEvents.action, actorUserId: auditEvents.actorUserId, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, guardianRequest.id));
    expect(audit).toEqual({
      action: "class.membership.requested",
      actorUserId: guardian.userId,
      metadata: {
        membershipId: guardianRequest.id,
        studentProfileId: student.id,
        classId: guardianClass.id,
        oldState: null,
        newState: "requested",
      },
    });

    await expect(integrationService.requestClassMembership(
      guardian,
      guardianClass.inviteCode,
      student.id,
    )).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
  });

  it("does not translate an unrelated nested unique violation as a student conflict", async () => {
    const guardian = await seedActor(["guardian"]);
    const unrelatedUnique = Object.assign(new Error("unrelated unique"), {
      cause: { code: "23505", constraint: "user_roles_user_role_unique" },
    });
    class UnrelatedUniqueRepository extends AccessRepository {
      override async createStudentForGuardian(
        ..._args: Parameters<AccessRepository["createStudentForGuardian"]>
      ): Promise<never> {
        throw unrelatedUnique;
      }
    }
    const service = new AccessService(integrationDb, new UnrelatedUniqueRepository(integrationDb));

    await expect(service.createStudentForGuardian(guardian, {
      studentExternalSubject: `unrelated-unique-${randomUUID()}`,
      displayName: "Unrelated unique",
      grade: 7,
      semester: 1,
    })).rejects.toBe(unrelatedUnique);
  });

  it("does not translate an unrelated nested unique violation as an open-membership conflict", async () => {
    const guardian = await seedActor(["guardian"]);
    const teacher = await seedActor(["teacher"], { teacherProfile: true });
    const student = await integrationService.createStudentForGuardian(guardian, {
      studentExternalSubject: `request-unique-${randomUUID()}`,
      displayName: "Request unique",
      grade: 7,
      semester: 1,
    });
    const createdClass = await integrationService.createClass(teacher, {
      name: "Request unique class",
      subject: "math",
    });
    const unrelatedUnique = Object.assign(new Error("unrelated request unique"), {
      cause: { code: "23505", constraint: "audit_events_unrelated_unique" },
    });
    class UnrelatedUniqueRepository extends AccessRepository {
      override async appendMembershipAudit(
        ..._args: Parameters<AccessRepository["appendMembershipAudit"]>
      ): Promise<void> {
        throw unrelatedUnique;
      }
    }
    const service = new AccessService(integrationDb, new UnrelatedUniqueRepository(integrationDb));

    await expect(service.requestClassMembership(
      guardian,
      createdClass.inviteCode,
      student.id,
    )).rejects.toBe(unrelatedUnique);
  });
});

describe("permission-bearing creation audits", () => {
  it("audits student and guardian relationship creation without the external subject", async () => {
    const guardian = await seedActor(["guardian"]);
    const externalSubject = `audited-child-${randomUUID()}`;

    const student = await integrationService.createStudentForGuardian(guardian, {
      studentExternalSubject: externalSubject,
      displayName: "Audited child",
      grade: 8,
      semester: 2,
    });

    const [audit] = await integrationDb
      .select({ action: auditEvents.action, actorUserId: auditEvents.actorUserId, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(and(
        eq(auditEvents.subjectType, "student_profile"),
        eq(auditEvents.subjectId, student.id),
      ));
    expect(audit).toEqual({
      action: "student.created",
      actorUserId: guardian.userId,
      metadata: {
        studentProfileId: student.id,
        studentUserId: student.userId,
        guardianUserId: guardian.userId,
        guardianLinkId: expect.any(String),
      },
    });
    expect(JSON.stringify(audit?.metadata)).not.toContain(externalSubject);
  });

  it("audits class creation without persisting the invite code in audit metadata", async () => {
    const teacher = await seedActor(["teacher"], { teacherProfile: true });
    const createdClass = await integrationService.createClass(teacher, {
      name: "Audited class",
      subject: "math",
    });

    const [audit] = await integrationDb
      .select({ action: auditEvents.action, actorUserId: auditEvents.actorUserId, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(and(
        eq(auditEvents.subjectType, "class"),
        eq(auditEvents.subjectId, createdClass.id),
      ));
    expect(audit).toEqual({
      action: "class.created",
      actorUserId: teacher.userId,
      metadata: {
        classId: createdClass.id,
        teacherProfileId: createdClass.teacherProfileId,
        teacherUserId: teacher.userId,
        subject: "math",
      },
    });
    expect(audit?.metadata).not.toHaveProperty("inviteCode");
  });

  it.each(["student", "class"] as const)(
    "rolls %s creation back when its audit append fails",
    async (target) => {
      class FailingCreationAuditRepository extends AccessRepository {
        override async appendStudentCreatedAudit(
          _transaction: AccessTransaction,
          _actorUserId: string,
          _metadata: StudentCreatedAuditMetadata,
        ): Promise<void> {
          if (target === "student") throw new Error("forced student creation audit failure");
        }

        override async appendClassCreatedAudit(
          _transaction: AccessTransaction,
          _actorUserId: string,
          _metadata: ClassCreatedAuditMetadata,
        ): Promise<void> {
          if (target === "class") throw new Error("forced class creation audit failure");
        }
      }
      const service = new AccessService(
        integrationDb,
        new FailingCreationAuditRepository(integrationDb),
        () => `audit-failure-${randomUUID()}`,
      );

      if (target === "student") {
        const guardian = await seedActor(["guardian"]);
        const externalSubject = `rollback-child-${randomUUID()}`;
        await expect(service.createStudentForGuardian(guardian, {
          studentExternalSubject: externalSubject,
          displayName: "Rollback child",
          grade: 7,
          semester: 1,
        })).rejects.toThrow("forced student creation audit failure");
        const rows = await integrationDb
          .select({ id: users.id })
          .from(users)
          .where(eq(users.externalSubject, externalSubject));
        expect(rows).toEqual([]);
      } else {
        const teacher = await seedActor(["teacher"], { teacherProfile: true });
        const name = `Rollback class ${randomUUID()}`;
        await expect(service.createClass(teacher, { name, subject: "math" }))
          .rejects.toThrow("forced class creation audit failure");
        const rows = await integrationDb
          .select({ id: classes.id })
          .from(classes)
          .where(eq(classes.name, name));
        expect(rows).toEqual([]);
      }
    },
  );
});

describe("guardian-approved membership transitions", () => {
  it("lets the owning teacher read status but only the linked guardian approve directly to active", async () => {
    const scenario = await createRequestedMembership();
    const unrelatedTeacher = await seedActor(["teacher"], { teacherProfile: true });

    await expect(integrationService.getClassMembershipForTeacher(
      unrelatedTeacher,
      scenario.membership.id,
    )).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
    await expect(integrationService.getClassMembershipForTeacher(
      scenario.teacher,
      randomUUID(),
    )).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
    await expect(integrationService.getClassMembershipForTeacher(
      scenario.teacher,
      scenario.membership.id,
    )).resolves.toMatchObject({ state: "requested" });

    await expect(integrationService.approveClassMembership(
      scenario.teacher,
      scenario.membership.id,
    )).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    const grant = await integrationService.approveClassMembership(
      scenario.guardian,
      scenario.membership.id,
    );
    const exactScope: SharingScope = grant.scope;
    expect(exactScope).toBe("learning_summary");
    expect(grant).toMatchObject({
      classMembershipId: scenario.membership.id,
      studentProfileId: scenario.student.id,
      scope: "learning_summary",
      revokedAt: null,
    });

    const [membership] = await integrationDb
      .select()
      .from(classMemberships)
      .where(eq(classMemberships.id, scenario.membership.id));
    expect(membership).toMatchObject({ state: "active", resolvedAt: expect.any(Date) });
    await expect(decideStudentRead(
      integrationRepository,
      scenario.teacher,
      scenario.student.id,
      "learning_summary",
    )).resolves.toEqual({ allowed: true, reason: "class_grant" });
    await expect(decideStudentRead(
      integrationRepository,
      scenario.teacher,
      scenario.student.id,
      "shared_personal_content",
    )).resolves.toEqual({ allowed: false, reason: "not_authorized" });

    const grants = await integrationDb
      .select({ scope: dataSharingGrants.scope })
      .from(dataSharingGrants)
      .where(eq(dataSharingGrants.classMembershipId, scenario.membership.id));
    expect(grants).toEqual([{ scope: "learning_summary" }]);

    const audits = await integrationDb
      .select({ action: auditEvents.action, actorUserId: auditEvents.actorUserId, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, scenario.membership.id));
    expect(audits).toEqual(expect.arrayContaining([
      {
        action: "class.membership.requested",
        actorUserId: scenario.guardian.userId,
        metadata: {
          membershipId: scenario.membership.id,
          studentProfileId: scenario.student.id,
          classId: scenario.createdClass.id,
          oldState: null,
          newState: "requested",
        },
      },
      {
        action: "class.membership.approved",
        actorUserId: scenario.guardian.userId,
        metadata: {
          membershipId: scenario.membership.id,
          studentProfileId: scenario.student.id,
          classId: scenario.createdClass.id,
          oldState: "requested",
          newState: "active",
        },
      },
    ]));
  });

  it("rejects membership only for an active linked guardian and returns 409 on invalid repeats", async () => {
    const scenario = await createRequestedMembership();

    await expect(integrationService.rejectClassMembership(
      scenario.teacher,
      scenario.membership.id,
    )).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    const rejected = await integrationService.rejectClassMembership(
      scenario.guardian,
      scenario.membership.id,
    );
    expect(rejected).toMatchObject({ state: "rejected", resolvedAt: expect.any(Date) });
    await expect(integrationService.rejectClassMembership(
      scenario.guardian,
      scenario.membership.id,
    )).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
    await expect(integrationService.approveClassMembership(
      scenario.guardian,
      scenario.membership.id,
    )).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });

    const [audit] = await integrationDb
      .select({ actorUserId: auditEvents.actorUserId, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(and(
        eq(auditEvents.subjectId, scenario.membership.id),
        eq(auditEvents.action, "class.membership.rejected"),
      ));
    expect(audit).toEqual({
      actorUserId: scenario.guardian.userId,
      metadata: {
        membershipId: scenario.membership.id,
        studentProfileId: scenario.student.id,
        classId: scenario.createdClass.id,
        oldState: "requested",
        newState: "rejected",
      },
    });
  });

  it("revokes every active grant in the same transaction before leaving active", async () => {
    const scenario = await createRequestedMembership();
    await integrationService.approveClassMembership(scenario.guardian, scenario.membership.id);

    await expect(integrationService.revokeClassMembership(
      scenario.teacher,
      scenario.membership.id,
    )).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    const revoked = await integrationService.revokeClassMembership(
      scenario.guardian,
      scenario.membership.id,
    );
    expect(revoked).toMatchObject({ state: "revoked", resolvedAt: expect.any(Date) });
    const [grant] = await integrationDb
      .select({ revokedAt: dataSharingGrants.revokedAt })
      .from(dataSharingGrants)
      .where(eq(dataSharingGrants.classMembershipId, scenario.membership.id));
    expect(grant?.revokedAt).toBeInstanceOf(Date);
    await expect(decideStudentRead(
      integrationRepository,
      scenario.teacher,
      scenario.student.id,
      "learning_summary",
    )).resolves.toEqual({ allowed: false, reason: "not_authorized" });
    await expect(integrationService.revokeClassMembership(
      scenario.guardian,
      scenario.membership.id,
    )).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });

    const [audit] = await integrationDb
      .select({ actorUserId: auditEvents.actorUserId, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(and(
        eq(auditEvents.subjectId, scenario.membership.id),
        eq(auditEvents.action, "class.membership.revoked"),
      ));
    expect(audit).toEqual({
      actorUserId: scenario.guardian.userId,
      metadata: {
        membershipId: scenario.membership.id,
        studentProfileId: scenario.student.id,
        classId: scenario.createdClass.id,
        oldState: "active",
        newState: "revoked",
      },
    });
  });

  it("denies transitions after the guardian link is revoked", async () => {
    const scenario = await createRequestedMembership();
    await integrationDb
      .update(guardianLinks)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(guardianLinks.guardianUserId, scenario.guardian.userId),
        eq(guardianLinks.studentProfileId, scenario.student.id),
      ));

    await expect(integrationService.approveClassMembership(
      scenario.guardian,
      scenario.membership.id,
    )).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });

  it.each(["grant", "audit"] as const)(
    "rolls approval back to requested when the %s write fails",
    async (failurePoint) => {
      const scenario = await createRequestedMembership();
      class FailingAccessRepository extends AccessRepository {
        override async createLearningSummaryGrant(...args: Parameters<AccessRepository["createLearningSummaryGrant"]>) {
          if (failurePoint === "grant") throw new Error("forced grant failure");
          return super.createLearningSummaryGrant(...args);
        }

        override async appendMembershipAudit(...args: Parameters<AccessRepository["appendMembershipAudit"]>) {
          const metadata = args[2];
          if (failurePoint === "audit" && metadata.newState === "active") {
            throw new Error("forced audit failure");
          }
          return super.appendMembershipAudit(...args);
        }
      }
      const failingRepository = new FailingAccessRepository(integrationDb);
      const failingService = new AccessService(
        integrationDb,
        failingRepository,
        () => `unused-${randomUUID()}`,
      );

      await expect(failingService.approveClassMembership(
        scenario.guardian,
        scenario.membership.id,
      )).rejects.toThrow(`forced ${failurePoint} failure`);

      const [membership] = await integrationDb
        .select({ state: classMemberships.state, resolvedAt: classMemberships.resolvedAt })
        .from(classMemberships)
        .where(eq(classMemberships.id, scenario.membership.id));
      const grants = await integrationDb
        .select()
        .from(dataSharingGrants)
        .where(eq(dataSharingGrants.classMembershipId, scenario.membership.id));
      const [auditCount] = await integrationDb
        .select({ value: count() })
        .from(auditEvents)
        .where(eq(auditEvents.subjectId, scenario.membership.id));
      expect(membership).toEqual({ state: "requested", resolvedAt: null });
      expect(grants).toEqual([]);
      expect(auditCount?.value).toBe(1);
    },
  );
});

describe("guardian relationship lock ordering", () => {
  class RecordingLockRepository extends AccessRepository {
    readonly events: string[] = [];

    override async findMembershipForTransition(
      transaction: AccessTransaction,
      membershipId: string,
    ): Promise<ClassMembership | undefined> {
      this.events.push("membership-preview");
      return super.findMembershipForTransition(transaction, membershipId);
    }

    override async lockActiveGuardianLink(
      transaction: AccessTransaction,
      guardianUserId: string,
      studentProfileId: string,
    ): Promise<boolean> {
      this.events.push("guardian-link-for-update");
      return super.lockActiveGuardianLink(transaction, guardianUserId, studentProfileId);
    }

    override async lockMembership(
      transaction: AccessTransaction,
      membershipId: string,
    ): Promise<ClassMembership | undefined> {
      this.events.push("membership-for-update");
      return super.lockMembership(transaction, membershipId);
    }

    override async hasActiveGuardianLinkIn(
      transaction: AccessTransaction,
      actorUserId: string,
      studentProfileId: string,
    ): Promise<boolean> {
      this.events.push("guardian-link-unlocked");
      return super.hasActiveGuardianLinkIn(transaction, actorUserId, studentProfileId);
    }
  }

  it("locks guardian link before membership during a guardian transition", async () => {
    const scenario = await createRequestedMembership();
    const recordingRepository = new RecordingLockRepository(integrationDb);
    const service = new AccessService(integrationDb, recordingRepository);

    await expect(service.rejectClassMembership(
      scenario.guardian,
      scenario.membership.id,
    )).resolves.toMatchObject({ state: "rejected" });
    expect(recordingRepository.events).toEqual([
      "membership-preview",
      "guardian-link-for-update",
      "membership-for-update",
    ]);
  });

  it("locks the active guardian link before creating a membership request", async () => {
    const guardian = await seedActor(["guardian"]);
    const teacher = await seedActor(["teacher"], { teacherProfile: true });
    const student = await integrationService.createStudentForGuardian(guardian, {
      studentExternalSubject: `lock-request-${randomUUID()}`,
      displayName: "Lock request",
      grade: 7,
      semester: 1,
    });
    const createdClass = await integrationService.createClass(teacher, {
      name: "Lock request class",
      subject: "math",
    });
    const recordingRepository = new RecordingLockRepository(integrationDb);
    const service = new AccessService(integrationDb, recordingRepository);

    await expect(service.requestClassMembership(
      guardian,
      createdClass.inviteCode,
      student.id,
    )).resolves.toMatchObject({ state: "requested" });
    expect(recordingRepository.events).toEqual(["guardian-link-for-update"]);
  });

  it("returns the same 403 when the membership changes between preview and final lock", async () => {
    const scenario = await createRequestedMembership();
    class ChangedMembershipRepository extends AccessRepository {
      override async lockMembership(
        transaction: AccessTransaction,
        membershipId: string,
      ): Promise<ClassMembership | undefined> {
        const membership = await super.lockMembership(transaction, membershipId);
        return membership === undefined ? undefined : { ...membership, state: "active" };
      }
    }
    const service = new AccessService(
      integrationDb,
      new ChangedMembershipRepository(integrationDb),
    );

    await expect(service.approveClassMembership(
      scenario.guardian,
      scenario.membership.id,
    )).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });

  it("returns 403 without grant or transition audit when the class changes after preview", async () => {
    const scenario = await createRequestedMembership();
    class ChangedClassRepository extends AccessRepository {
      override async lockMembership(
        transaction: AccessTransaction,
        membershipId: string,
      ): Promise<ClassMembership | undefined> {
        const membership = await super.lockMembership(transaction, membershipId);
        return membership === undefined
          ? undefined
          : { ...membership, classId: randomUUID() };
      }
    }
    const service = new AccessService(
      integrationDb,
      new ChangedClassRepository(integrationDb),
    );

    await expect(service.approveClassMembership(
      scenario.guardian,
      scenario.membership.id,
    )).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    const [grantCount] = await integrationDb
      .select({ value: count() })
      .from(dataSharingGrants)
      .where(eq(dataSharingGrants.classMembershipId, scenario.membership.id));
    const [approvalAuditCount] = await integrationDb
      .select({ value: count() })
      .from(auditEvents)
      .where(and(
        eq(auditEvents.subjectId, scenario.membership.id),
        eq(auditEvents.action, "class.membership.approved"),
      ));
    expect(grantCount?.value).toBe(0);
    expect(approvalAuditCount?.value).toBe(0);
  });
});

function actorHeaders(actor: Actor): Record<string, string> {
  return {
    "x-dev-user-id": actor.userId,
    "x-dev-roles": actor.roles.join(","),
  };
}

async function buildAccessRouteApp() {
  const app = Fastify({ logger: false });
  await registerActorPlugin(app, {
    provider: new DevIdentityProvider(),
    nodeEnv: "test",
    devIdentityEnabled: true,
  });
  await app.register(registerAccessRoutes, {
    service: integrationService,
    repository: integrationRepository,
  });
  return app;
}

describe("access HTTP routes", () => {
  it("registers injected access routes through the real application composition", async () => {
    const app = await buildApp({
      actorPlugin: {
        provider: new DevIdentityProvider(),
        nodeEnv: "test",
        devIdentityEnabled: true,
      },
      accessRoutes: {
        service: integrationService,
        repository: integrationRepository,
      },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/access/class-memberships/${randomUUID()}`,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: "UNAUTHORIZED" });
    } finally {
      await app.close();
    }
  });

  it.each(["approve", "reject", "revoke"] as const)(
    "rejects a non-empty %s transition body",
    async (transition) => {
      const app = await buildAccessRouteApp();
      const guardian = await seedActor(["guardian"]);
      try {
        const response = await app.inject({
          method: "POST",
          url: `/access/class-memberships/${randomUUID()}/${transition}`,
          headers: actorHeaders(guardian),
          payload: { unexpected: true },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ code: "BAD_REQUEST" });
      } finally {
        await app.close();
      }
    },
  );

  it("enforces strict inputs and completes guardian-approved sharing without target disclosure", async () => {
    const app = await buildAccessRouteApp();
    const guardian = await seedActor(["guardian"]);
    const unrelatedGuardian = await seedActor(["guardian"]);
    const teacher = await seedActor(["teacher"], { teacherProfile: true });
    const unrelatedTeacher = await seedActor(["teacher"], { teacherProfile: true });

    try {
      const unauthenticated = await app.inject({
        method: "POST",
        url: "/access/students",
        payload: {
          studentExternalSubject: `route-unauth-${randomUUID()}`,
          displayName: "Unauthenticated",
          grade: 7,
          semester: 1,
        },
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect(unauthenticated.json()).toMatchObject({ code: "UNAUTHORIZED" });

      const invalidStudent = await app.inject({
        method: "POST",
        url: "/access/students",
        headers: actorHeaders(guardian),
        payload: {
          studentExternalSubject: `route-invalid-${randomUUID()}`,
          displayName: "Invalid",
          grade: 6,
          semester: 1,
          unexpected: true,
        },
      });
      expect(invalidStudent.statusCode).toBe(400);
      expect(invalidStudent.json()).toMatchObject({ code: "BAD_REQUEST" });

      const studentResponse = await app.inject({
        method: "POST",
        url: "/access/students",
        headers: actorHeaders(guardian),
        payload: {
          studentExternalSubject: `route-child-${randomUUID()}`,
          displayName: "Route child",
          grade: 7,
          semester: 2,
        },
      });
      expect(studentResponse.statusCode).toBe(201);
      const student = studentResponse.json<{ id: string; userId: string }>();

      const inviteInjection = await app.inject({
        method: "POST",
        url: "/access/classes",
        headers: actorHeaders(teacher),
        payload: { name: "Injected", subject: "math", inviteCode: "caller-controlled" },
      });
      expect(inviteInjection.statusCode).toBe(400);
      expect(inviteInjection.json()).toMatchObject({ code: "BAD_REQUEST" });

      const classResponse = await app.inject({
        method: "POST",
        url: "/access/classes",
        headers: actorHeaders(teacher),
        payload: { name: "Route class", subject: "math" },
      });
      expect(classResponse.statusCode).toBe(201);
      const createdClass = classResponse.json<{ inviteCode: string }>();
      expect(createdClass.inviteCode).toMatch(/^invite-/);

      const joinResponse = await app.inject({
        method: "POST",
        url: "/access/classes/join",
        headers: actorHeaders(guardian),
        payload: { inviteCode: createdClass.inviteCode, studentId: student.id },
      });
      expect(joinResponse.statusCode).toBe(201);
      const membership = joinResponse.json<{ id: string; state: string }>();
      expect(membership.state).toBe("requested");

      const teacherStatus = await app.inject({
        method: "GET",
        url: `/access/class-memberships/${membership.id}`,
        headers: actorHeaders(teacher),
      });
      expect(teacherStatus.statusCode).toBe(200);
      expect(teacherStatus.json()).toMatchObject({ state: "requested" });

      const invalidMembershipId = await app.inject({
        method: "GET",
        url: "/access/class-memberships/not-a-uuid",
        headers: actorHeaders(teacher),
      });
      expect(invalidMembershipId.statusCode).toBe(400);
      expect(invalidMembershipId.json()).toMatchObject({ code: "BAD_REQUEST" });

      const teacherApprove = await app.inject({
        method: "POST",
        url: `/access/class-memberships/${membership.id}/approve`,
        headers: actorHeaders(teacher),
      });
      expect(teacherApprove.statusCode).toBe(403);

      const unrelatedApprove = await app.inject({
        method: "POST",
        url: `/access/class-memberships/${membership.id}/approve`,
        headers: actorHeaders(unrelatedGuardian),
      });
      const missingApprove = await app.inject({
        method: "POST",
        url: `/access/class-memberships/${randomUUID()}/approve`,
        headers: actorHeaders(unrelatedGuardian),
      });
      expect(unrelatedApprove.statusCode).toBe(403);
      expect(missingApprove.statusCode).toBe(403);
      expect(unrelatedApprove.json()).toEqual(missingApprove.json());

      const approved = await app.inject({
        method: "POST",
        url: `/access/class-memberships/${membership.id}/approve`,
        headers: actorHeaders(guardian),
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json()).toMatchObject({ scope: "learning_summary" });

      const repeatedApproval = await app.inject({
        method: "POST",
        url: `/access/class-memberships/${membership.id}/approve`,
        headers: actorHeaders(guardian),
      });
      expect(repeatedApproval.statusCode).toBe(409);
      expect(repeatedApproval.json()).toMatchObject({ code: "CONFLICT" });

      const learningProbe = await app.inject({
        method: "GET",
        url: `/access/students/${student.id}/sharing/learning_summary`,
        headers: actorHeaders(teacher),
      });
      expect(learningProbe.statusCode).toBe(200);
      expect(learningProbe.json()).toEqual({ allowed: true, reason: "class_grant" });

      const personalProbe = await app.inject({
        method: "GET",
        url: `/access/students/${student.id}/sharing/shared_personal_content`,
        headers: actorHeaders(teacher),
      });
      expect(personalProbe.statusCode).toBe(403);
      expect(personalProbe.json()).toMatchObject({ code: "FORBIDDEN" });

      const unrelatedProbe = await app.inject({
        method: "GET",
        url: `/access/students/${student.id}/sharing/learning_summary`,
        headers: actorHeaders(unrelatedTeacher),
      });
      const missingProbe = await app.inject({
        method: "GET",
        url: `/access/students/${randomUUID()}/sharing/learning_summary`,
        headers: actorHeaders(unrelatedTeacher),
      });
      expect(unrelatedProbe.statusCode).toBe(403);
      expect(missingProbe.statusCode).toBe(403);
      expect(unrelatedProbe.json()).toEqual(missingProbe.json());

      const revoked = await app.inject({
        method: "POST",
        url: `/access/class-memberships/${membership.id}/revoke`,
        headers: actorHeaders(guardian),
      });
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json()).toMatchObject({ state: "revoked" });

      const rejectClassResponse = await app.inject({
        method: "POST",
        url: "/access/classes",
        headers: actorHeaders(teacher),
        payload: { name: "Reject route class", subject: "math" },
      });
      const rejectClass = rejectClassResponse.json<{ inviteCode: string }>();
      const rejectJoin = await app.inject({
        method: "POST",
        url: "/access/classes/join",
        headers: actorHeaders({ userId: student.userId, roles: ["student"] }),
        payload: { inviteCode: rejectClass.inviteCode, studentId: student.id },
      });
      const rejected = await app.inject({
        method: "POST",
        url: `/access/class-memberships/${rejectJoin.json<{ id: string }>().id}/reject`,
        headers: actorHeaders(guardian),
      });
      expect(rejected.statusCode).toBe(200);
      expect(rejected.json()).toMatchObject({ state: "rejected" });
    } finally {
      await app.close();
    }
  });
});
