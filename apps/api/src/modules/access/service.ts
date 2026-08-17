import { randomBytes } from "node:crypto";
import type { Actor } from "@math/contracts";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { ForbiddenError, requireRole } from "../../plugins/actor.js";
import type {
  Class,
  ClassMembership,
  CreateClassInput,
  CreateStudentInput,
  DataSharingGrant,
  StudentProfile,
} from "./repository.js";
import { AccessRepository, type AccessTransaction } from "./repository.js";

type TransactionHost = PgDatabase<any, any, any>;
export type InviteCodeGenerator = () => string;

export class ConflictError extends Error {
  readonly code = "CONFLICT";
  readonly statusCode = 409;

  constructor(message = "CONFLICT") {
    super(message);
    this.name = "ConflictError";
  }
}

function defaultInviteCodeGenerator(): string {
  return randomBytes(16).toString("base64url");
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "23505") return true;
  return "cause" in error && isUniqueViolation(error.cause);
}

export class AccessService {
  constructor(
    private readonly database: TransactionHost,
    private readonly repository: AccessRepository,
    private readonly inviteCodeGenerator: InviteCodeGenerator = defaultInviteCodeGenerator,
  ) {}

  async createStudentForGuardian(
    actor: Actor,
    input: CreateStudentInput,
  ): Promise<StudentProfile> {
    requireRole(actor, ["guardian"]);
    try {
      return await this.database.transaction((transaction) =>
        this.repository.createStudentForGuardian(transaction, actor.userId, input));
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError("STUDENT_EXTERNAL_SUBJECT_EXISTS");
      throw error;
    }
  }

  async createClass(actor: Actor, input: CreateClassInput): Promise<Class> {
    requireRole(actor, ["teacher"]);
    return this.database.transaction(async (transaction) => {
      const teacherProfileId = await this.repository.findTeacherProfileId(transaction, actor.userId);
      if (teacherProfileId === undefined) throw new ForbiddenError();
      return this.repository.createClass(
        transaction,
        teacherProfileId,
        input,
        this.inviteCodeGenerator(),
      );
    });
  }

  async requestClassMembership(
    actor: Actor,
    inviteCode: string,
    studentProfileId: string,
  ): Promise<ClassMembership> {
    try {
      return await this.database.transaction(async (transaction) => {
        const mayRequest = await this.mayRequestMembership(transaction, actor, studentProfileId);
        if (!mayRequest) throw new ForbiddenError();

        const classId = await this.repository.findClassIdByInvite(transaction, inviteCode);
        if (classId === undefined) throw new ForbiddenError();

        const membership = await this.repository.createMembership(
          transaction,
          classId,
          studentProfileId,
        );
        await this.repository.appendMembershipAudit(transaction, actor.userId, {
          membershipId: membership.id,
          studentProfileId,
          classId,
          oldState: null,
          newState: "requested",
        });
        return membership;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError("OPEN_MEMBERSHIP_EXISTS");
      throw error;
    }
  }

  async getClassMembershipForTeacher(
    actor: Actor,
    membershipId: string,
  ): Promise<ClassMembership> {
    requireRole(actor, ["teacher"]);
    const membership = await this.repository.findTeacherOwnedMembership(actor.userId, membershipId);
    if (membership === undefined) throw new ForbiddenError();
    return membership;
  }

  async approveClassMembership(
    actor: Actor,
    membershipId: string,
  ): Promise<DataSharingGrant> {
    requireRole(actor, ["guardian"]);
    return this.database.transaction(async (transaction) => {
      const membership = await this.lockGuardianMembership(transaction, actor, membershipId);
      this.requireState(membership, "requested");
      const active = await this.repository.updateMembershipState(
        transaction,
        membership.id,
        "active",
        new Date(),
      );
      const grant = await this.repository.createLearningSummaryGrant(transaction, active);
      await this.repository.appendMembershipAudit(transaction, actor.userId, {
        membershipId: membership.id,
        studentProfileId: membership.studentProfileId,
        classId: membership.classId,
        oldState: "requested",
        newState: "active",
      });
      return grant;
    });
  }

  async rejectClassMembership(
    actor: Actor,
    membershipId: string,
  ): Promise<ClassMembership> {
    requireRole(actor, ["guardian"]);
    return this.database.transaction(async (transaction) => {
      const membership = await this.lockGuardianMembership(transaction, actor, membershipId);
      this.requireState(membership, "requested");
      const rejected = await this.repository.updateMembershipState(
        transaction,
        membership.id,
        "rejected",
        new Date(),
      );
      await this.repository.appendMembershipAudit(transaction, actor.userId, {
        membershipId: membership.id,
        studentProfileId: membership.studentProfileId,
        classId: membership.classId,
        oldState: "requested",
        newState: "rejected",
      });
      return rejected;
    });
  }

  async revokeClassMembership(
    actor: Actor,
    membershipId: string,
  ): Promise<ClassMembership> {
    requireRole(actor, ["guardian"]);
    return this.database.transaction(async (transaction) => {
      const membership = await this.lockGuardianMembership(transaction, actor, membershipId);
      this.requireState(membership, "active");
      const resolvedAt = new Date();
      await this.repository.revokeActiveGrants(transaction, membership.id, resolvedAt);
      const revoked = await this.repository.updateMembershipState(
        transaction,
        membership.id,
        "revoked",
        resolvedAt,
      );
      await this.repository.appendMembershipAudit(transaction, actor.userId, {
        membershipId: membership.id,
        studentProfileId: membership.studentProfileId,
        classId: membership.classId,
        oldState: "active",
        newState: "revoked",
      });
      return revoked;
    });
  }

  private async lockGuardianMembership(
    transaction: AccessTransaction,
    actor: Actor,
    membershipId: string,
  ): Promise<ClassMembership> {
    const membership = await this.repository.lockMembership(transaction, membershipId);
    if (membership === undefined) throw new ForbiddenError();
    if (!await this.repository.hasActiveGuardianLinkIn(
      transaction,
      actor.userId,
      membership.studentProfileId,
    )) {
      throw new ForbiddenError();
    }
    return membership;
  }

  private requireState(
    membership: ClassMembership,
    expected: "requested" | "active",
  ): void {
    if (membership.state !== expected) {
      throw new ConflictError("INVALID_MEMBERSHIP_TRANSITION");
    }
  }

  private async mayRequestMembership(
    transaction: AccessTransaction,
    actor: Actor,
    studentProfileId: string,
  ): Promise<boolean> {
    if (
      actor.roles.includes("student") &&
      await this.repository.isStudentUserIn(transaction, actor.userId, studentProfileId)
    ) {
      return true;
    }
    return actor.roles.includes("guardian") &&
      await this.repository.hasActiveGuardianLinkIn(transaction, actor.userId, studentProfileId);
  }
}

export type {
  Class,
  ClassMembership,
  CreateClassInput,
  CreateStudentInput,
  DataSharingGrant,
  StudentProfile,
} from "./repository.js";
