import type { Actor } from "@math/contracts";

export type SharingScope = "learning_summary" | "shared_personal_content";

export interface SharingDecision {
  allowed: boolean;
  reason: "self" | "guardian_link" | "class_grant" | "operator" | "not_authorized";
}

export interface AccessDecisionRepository {
  isStudentUser(actorUserId: string, studentProfileId: string): Promise<boolean>;
  hasActiveGuardianLink(actorUserId: string, studentProfileId: string): Promise<boolean>;
  hasActiveClassGrant(
    actorUserId: string,
    studentProfileId: string,
    scope: SharingScope,
  ): Promise<boolean>;
}

export async function decideStudentRead(
  repository: AccessDecisionRepository,
  actor: Actor,
  studentProfileId: string,
  scope: SharingScope,
): Promise<SharingDecision> {
  if (actor.roles.includes("operator")) {
    return { allowed: true, reason: "operator" };
  }

  if (
    actor.roles.includes("student") &&
    await repository.isStudentUser(actor.userId, studentProfileId)
  ) {
    return { allowed: true, reason: "self" };
  }

  if (
    actor.roles.includes("guardian") &&
    await repository.hasActiveGuardianLink(actor.userId, studentProfileId)
  ) {
    return { allowed: true, reason: "guardian_link" };
  }

  if (
    actor.roles.includes("teacher") &&
    await repository.hasActiveClassGrant(actor.userId, studentProfileId, scope)
  ) {
    return { allowed: true, reason: "class_grant" };
  }

  return { allowed: false, reason: "not_authorized" };
}
