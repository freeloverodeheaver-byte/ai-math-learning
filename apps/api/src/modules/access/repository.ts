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
import { and, eq, isNull } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { AccessDecisionRepository, SharingScope } from "./policy.js";

export type AccessTransaction = PgDatabase<any, any, any>;

export interface CreateStudentInput {
  studentExternalSubject: string;
  displayName: string;
  grade: 7 | 8 | 9;
  semester: 1 | 2;
}

export interface CreateClassInput {
  name: string;
  subject: "math";
}

export interface StudentProfile {
  id: string;
  userId: string;
  displayName: string;
  grade: number;
  semester: number;
  createdAt: Date;
}

export interface StudentCreatedAuditMetadata {
  studentProfileId: string;
  studentUserId: string;
  guardianUserId: string;
  guardianLinkId: string;
}

export interface ClassCreatedAuditMetadata {
  classId: string;
  teacherProfileId: string;
  teacherUserId: string;
  subject: "math";
}

interface CreatedStudentSetup {
  profile: StudentProfile;
  guardianLinkId: string;
}

export interface Class {
  id: string;
  teacherProfileId: string;
  name: string;
  subject: string;
  inviteCode: string;
  createdAt: Date;
}

export type MembershipState = "requested" | "active" | "rejected" | "revoked";

export interface ClassMembership {
  id: string;
  classId: string;
  studentProfileId: string;
  state: MembershipState;
  requestedAt: Date;
  resolvedAt: Date | null;
}

export interface DataSharingGrant {
  id: string;
  classMembershipId: string;
  studentProfileId: string;
  scope: SharingScope;
  grantedAt: Date;
  revokedAt: Date | null;
}

export interface MembershipAuditMetadata {
  membershipId: string;
  studentProfileId: string;
  classId: string;
  oldState: MembershipState | null;
  newState: MembershipState;
}

const studentSelection = {
  id: studentProfiles.id,
  userId: studentProfiles.userId,
  displayName: studentProfiles.displayName,
  grade: studentProfiles.grade,
  semester: studentProfiles.semester,
  createdAt: studentProfiles.createdAt,
};

const classSelection = {
  id: classes.id,
  teacherProfileId: classes.teacherProfileId,
  name: classes.name,
  subject: classes.subject,
  inviteCode: classes.inviteCode,
  createdAt: classes.createdAt,
};

const membershipSelection = {
  id: classMemberships.id,
  classId: classMemberships.classId,
  studentProfileId: classMemberships.studentProfileId,
  state: classMemberships.state,
  requestedAt: classMemberships.requestedAt,
  resolvedAt: classMemberships.resolvedAt,
};

const grantSelection = {
  id: dataSharingGrants.id,
  classMembershipId: dataSharingGrants.classMembershipId,
  studentProfileId: dataSharingGrants.studentProfileId,
  scope: dataSharingGrants.scope,
  grantedAt: dataSharingGrants.grantedAt,
  revokedAt: dataSharingGrants.revokedAt,
};

export class AccessRepository implements AccessDecisionRepository {
  constructor(private readonly database: AccessTransaction) {}

  async isStudentUser(actorUserId: string, studentProfileId: string): Promise<boolean> {
    return this.isStudentUserIn(this.database, actorUserId, studentProfileId);
  }

  async isStudentUserIn(
    transaction: AccessTransaction,
    actorUserId: string,
    studentProfileId: string,
  ): Promise<boolean> {
    const [row] = await transaction
      .select({ id: studentProfiles.id })
      .from(studentProfiles)
      .where(and(
        eq(studentProfiles.id, studentProfileId),
        eq(studentProfiles.userId, actorUserId),
      ))
      .limit(1);
    return row !== undefined;
  }

  async hasActiveGuardianLink(
    actorUserId: string,
    studentProfileId: string,
  ): Promise<boolean> {
    return this.hasActiveGuardianLinkIn(this.database, actorUserId, studentProfileId);
  }

  async hasActiveGuardianLinkIn(
    transaction: AccessTransaction,
    actorUserId: string,
    studentProfileId: string,
  ): Promise<boolean> {
    const [row] = await transaction
      .select({ id: guardianLinks.id })
      .from(guardianLinks)
      .where(and(
        eq(guardianLinks.guardianUserId, actorUserId),
        eq(guardianLinks.studentProfileId, studentProfileId),
        isNull(guardianLinks.revokedAt),
      ))
      .limit(1);
    return row !== undefined;
  }

  async lockActiveGuardianLink(
    transaction: AccessTransaction,
    guardianUserId: string,
    studentProfileId: string,
  ): Promise<boolean> {
    // Durable lock order for guardian-authorized writes is guardian_links first,
    // then class_memberships. A future guardian-link revoke must acquire this
    // same link row before touching memberships or grants.
    const [row] = await transaction
      .select({ id: guardianLinks.id })
      .from(guardianLinks)
      .where(and(
        eq(guardianLinks.guardianUserId, guardianUserId),
        eq(guardianLinks.studentProfileId, studentProfileId),
        isNull(guardianLinks.revokedAt),
      ))
      .for("update");
    return row !== undefined;
  }

  async hasActiveClassGrant(
    actorUserId: string,
    studentProfileId: string,
    scope: SharingScope,
  ): Promise<boolean> {
    const [row] = await this.database
      .select({ id: dataSharingGrants.id })
      .from(dataSharingGrants)
      .innerJoin(
        classMemberships,
        and(
          eq(dataSharingGrants.classMembershipId, classMemberships.id),
          eq(dataSharingGrants.studentProfileId, classMemberships.studentProfileId),
        ),
      )
      .innerJoin(classes, eq(classMemberships.classId, classes.id))
      .innerJoin(teacherProfiles, eq(classes.teacherProfileId, teacherProfiles.id))
      .where(and(
        eq(teacherProfiles.userId, actorUserId),
        eq(classMemberships.studentProfileId, studentProfileId),
        eq(classMemberships.state, "active"),
        eq(dataSharingGrants.scope, scope),
        isNull(dataSharingGrants.revokedAt),
      ))
      .limit(1);
    return row !== undefined;
  }

  async createStudentForGuardian(
    transaction: AccessTransaction,
    guardianUserId: string,
    input: CreateStudentInput,
  ): Promise<CreatedStudentSetup> {
    const [studentUser] = await transaction
      .insert(users)
      .values({ externalSubject: input.studentExternalSubject })
      .returning({ id: users.id });
    await transaction.insert(userRoles).values({ userId: studentUser!.id, role: "student" });
    const [profile] = await transaction
      .insert(studentProfiles)
      .values({
        userId: studentUser!.id,
        displayName: input.displayName,
        grade: input.grade,
        semester: input.semester,
      })
      .returning(studentSelection);
    const [guardianLink] = await transaction
      .insert(guardianLinks)
      .values({
        guardianUserId,
        studentProfileId: profile!.id,
      })
      .returning({ id: guardianLinks.id });
    return { profile: profile!, guardianLinkId: guardianLink!.id };
  }

  async findTeacherProfileId(
    transaction: AccessTransaction,
    teacherUserId: string,
  ): Promise<string | undefined> {
    const [profile] = await transaction
      .select({ id: teacherProfiles.id })
      .from(teacherProfiles)
      .where(eq(teacherProfiles.userId, teacherUserId))
      .limit(1);
    return profile?.id;
  }

  async createClass(
    transaction: AccessTransaction,
    teacherProfileId: string,
    input: CreateClassInput,
    inviteCode: string,
  ): Promise<Class> {
    const [createdClass] = await transaction
      .insert(classes)
      .values({ teacherProfileId, ...input, inviteCode })
      .returning(classSelection);
    return createdClass!;
  }

  async appendStudentCreatedAudit(
    transaction: AccessTransaction,
    actorUserId: string,
    metadata: StudentCreatedAuditMetadata,
  ): Promise<void> {
    await transaction.insert(auditEvents).values({
      actorUserId,
      action: "student.created",
      subjectType: "student_profile",
      subjectId: metadata.studentProfileId,
      metadata: { ...metadata },
    });
  }

  async appendClassCreatedAudit(
    transaction: AccessTransaction,
    actorUserId: string,
    metadata: ClassCreatedAuditMetadata,
  ): Promise<void> {
    await transaction.insert(auditEvents).values({
      actorUserId,
      action: "class.created",
      subjectType: "class",
      subjectId: metadata.classId,
      metadata: { ...metadata },
    });
  }

  async findClassIdByInvite(
    transaction: AccessTransaction,
    inviteCode: string,
  ): Promise<string | undefined> {
    const [row] = await transaction
      .select({ id: classes.id })
      .from(classes)
      .where(eq(classes.inviteCode, inviteCode))
      .limit(1);
    return row?.id;
  }

  async createMembership(
    transaction: AccessTransaction,
    classId: string,
    studentProfileId: string,
  ): Promise<ClassMembership> {
    const [membership] = await transaction
      .insert(classMemberships)
      .values({ classId, studentProfileId, state: "requested" })
      .returning(membershipSelection);
    return membership!;
  }

  async lockMembership(
    transaction: AccessTransaction,
    membershipId: string,
  ): Promise<ClassMembership | undefined> {
    const [membership] = await transaction
      .select(membershipSelection)
      .from(classMemberships)
      .where(eq(classMemberships.id, membershipId))
      .for("update");
    return membership;
  }

  async findMembershipForTransition(
    transaction: AccessTransaction,
    membershipId: string,
  ): Promise<ClassMembership | undefined> {
    const [membership] = await transaction
      .select(membershipSelection)
      .from(classMemberships)
      .where(eq(classMemberships.id, membershipId))
      .limit(1);
    return membership;
  }

  async updateMembershipState(
    transaction: AccessTransaction,
    membershipId: string,
    state: Exclude<MembershipState, "requested">,
    resolvedAt: Date,
  ): Promise<ClassMembership> {
    const [membership] = await transaction
      .update(classMemberships)
      .set({ state, resolvedAt })
      .where(eq(classMemberships.id, membershipId))
      .returning(membershipSelection);
    return membership!;
  }

  async createLearningSummaryGrant(
    transaction: AccessTransaction,
    membership: ClassMembership,
  ): Promise<DataSharingGrant> {
    const [grant] = await transaction
      .insert(dataSharingGrants)
      .values({
        classMembershipId: membership.id,
        studentProfileId: membership.studentProfileId,
        scope: "learning_summary",
      })
      .returning(grantSelection);
    if (
      grant === undefined ||
      (grant.scope !== "learning_summary" && grant.scope !== "shared_personal_content")
    ) {
      throw new Error("database returned an invalid sharing scope");
    }
    return { ...grant, scope: grant.scope };
  }

  async revokeActiveGrants(
    transaction: AccessTransaction,
    membershipId: string,
    revokedAt: Date,
  ): Promise<void> {
    await transaction
      .update(dataSharingGrants)
      .set({ revokedAt })
      .where(and(
        eq(dataSharingGrants.classMembershipId, membershipId),
        isNull(dataSharingGrants.revokedAt),
      ));
  }

  async findTeacherOwnedMembership(
    teacherUserId: string,
    membershipId: string,
  ): Promise<ClassMembership | undefined> {
    const [membership] = await this.database
      .select(membershipSelection)
      .from(classMemberships)
      .innerJoin(classes, eq(classMemberships.classId, classes.id))
      .innerJoin(teacherProfiles, eq(classes.teacherProfileId, teacherProfiles.id))
      .where(and(
        eq(classMemberships.id, membershipId),
        eq(teacherProfiles.userId, teacherUserId),
      ))
      .limit(1);
    return membership;
  }

  async appendMembershipAudit(
    transaction: AccessTransaction,
    actorUserId: string,
    metadata: MembershipAuditMetadata,
  ): Promise<void> {
    const action = {
      requested: "class.membership.requested",
      active: "class.membership.approved",
      rejected: "class.membership.rejected",
      revoked: "class.membership.revoked",
    } satisfies Record<MembershipState, string>;
    await transaction.insert(auditEvents).values({
      actorUserId,
      action: action[metadata.newState],
      subjectType: "class_membership",
      subjectId: metadata.membershipId,
      metadata: { ...metadata },
    });
  }
}
