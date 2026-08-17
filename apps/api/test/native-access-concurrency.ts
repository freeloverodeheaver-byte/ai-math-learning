import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Actor, Role } from "@math/contracts";
import {
  auditEvents,
  classMemberships,
  createDb,
  dataSharingGrants,
  guardianLinks,
  migrateDb,
  teacherProfiles,
  userRoles,
  users,
  type Database,
} from "@math/db";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import {
  AccessRepository,
  type AccessTransaction,
  type ClassMembership,
} from "../src/modules/access/repository.js";
import { AccessService } from "../src/modules/access/service.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error("TEST_DATABASE_URL is required for native PostgreSQL access concurrency tests");
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class Rendezvous {
  private arrived = 0;
  private readonly release = deferred();

  constructor(private readonly parties: number) {}

  async wait(): Promise<void> {
    this.arrived += 1;
    if (this.arrived === this.parties) this.release.resolve();
    await this.release.promise;
  }
}

interface BaseScenario {
  guardian: Actor;
  teacher: Actor;
  student: { id: string; userId: string };
  createdClass: { id: string; inviteCode: string };
}

async function seedActor(
  db: Database,
  roles: readonly Role[],
  teacherProfile = false,
): Promise<Actor> {
  const userId = randomUUID();
  await db.insert(users).values({ id: userId, externalSubject: `native-actor-${userId}` });
  await db.insert(userRoles).values(roles.map((role) => ({ userId, role })));
  if (teacherProfile) {
    await db.insert(teacherProfiles).values({ userId, displayName: `Native teacher ${userId}` });
  }
  return { userId, roles };
}

async function seedBase(db: Database, service: AccessService): Promise<BaseScenario> {
  const guardian = await seedActor(db, ["guardian"]);
  const teacher = await seedActor(db, ["teacher"], true);
  const student = await service.createStudentForGuardian(guardian, {
    studentExternalSubject: `native-student-${randomUUID()}`,
    displayName: "Native student",
    grade: 7,
    semester: 1,
  });
  const createdClass = await service.createClass(teacher, {
    name: `Native class ${randomUUID()}`,
    subject: "math",
  });
  return { guardian, teacher, student, createdClass };
}

async function duplicateRequestRace(dbA: Database, dbB: Database): Promise<void> {
  const baseRepository = new AccessRepository(dbA);
  const setupService = new AccessService(dbA, baseRepository);
  const scenario = await seedBase(dbA, setupService);
  const inserted = deferred();
  const allowCommit = deferred();

  class PauseAfterMembershipInsertRepository extends AccessRepository {
    override async createMembership(
      ...args: Parameters<AccessRepository["createMembership"]>
    ): Promise<ClassMembership> {
      const membership = await super.createMembership(...args);
      inserted.resolve();
      await allowCommit.promise;
      return membership;
    }
  }

  const firstService = new AccessService(
    dbA,
    new PauseAfterMembershipInsertRepository(dbA),
  );
  const secondService = new AccessService(dbB, new AccessRepository(dbB));
  const first = firstService.requestClassMembership(
    scenario.guardian,
    scenario.createdClass.inviteCode,
    scenario.student.id,
  );
  await inserted.promise;
  const second = secondService.requestClassMembership(
    scenario.guardian,
    scenario.createdClass.inviteCode,
    scenario.student.id,
  );
  const outcomesPromise = Promise.allSettled([first, second]);
  allowCommit.resolve();
  const outcomes = await outcomesPromise;

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.equal((rejected.reason as { statusCode?: number }).statusCode, 409);

  const [openCount] = await dbA
    .select({ value: count() })
    .from(classMemberships)
    .where(and(
      eq(classMemberships.classId, scenario.createdClass.id),
      eq(classMemberships.studentProfileId, scenario.student.id),
      inArray(classMemberships.state, ["requested", "active"]),
    ));
  assert.equal(openCount?.value, 1);
}

async function approveRejectRace(dbA: Database, dbB: Database): Promise<void> {
  const setupService = new AccessService(dbA, new AccessRepository(dbA));
  const scenario = await seedBase(dbA, setupService);
  const membership = await setupService.requestClassMembership(
    scenario.guardian,
    scenario.createdClass.inviteCode,
    scenario.student.id,
  );
  const previewBarrier = new Rendezvous(2);

  class BarrierAfterPreviewRepository extends AccessRepository {
    override async findMembershipForTransition(
      transaction: AccessTransaction,
      membershipId: string,
    ): Promise<ClassMembership | undefined> {
      const preview = await super.findMembershipForTransition(transaction, membershipId);
      await previewBarrier.wait();
      return preview;
    }
  }

  const approveService = new AccessService(dbA, new BarrierAfterPreviewRepository(dbA));
  const rejectService = new AccessService(dbB, new BarrierAfterPreviewRepository(dbB));
  const outcomes = await Promise.allSettled([
    approveService.approveClassMembership(scenario.guardian, membership.id),
    rejectService.rejectClassMembership(scenario.guardian, membership.id),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.ok([403, 409].includes((rejected.reason as { statusCode?: number }).statusCode ?? 0));

  const [finalMembership] = await dbA
    .select({ state: classMemberships.state })
    .from(classMemberships)
    .where(eq(classMemberships.id, membership.id));
  assert.ok(finalMembership?.state === "active" || finalMembership?.state === "rejected");
  const [grantCount] = await dbA
    .select({ value: count() })
    .from(dataSharingGrants)
    .where(and(
      eq(dataSharingGrants.classMembershipId, membership.id),
      isNull(dataSharingGrants.revokedAt),
    ));
  assert.equal(grantCount?.value, finalMembership.state === "active" ? 1 : 0);
  const [transitionAuditCount] = await dbA
    .select({ value: count() })
    .from(auditEvents)
    .where(and(
      eq(auditEvents.subjectId, membership.id),
      inArray(auditEvents.action, ["class.membership.approved", "class.membership.rejected"]),
    ));
  assert.equal(transitionAuditCount?.value, 1);
}

async function guardianRevokeApproveRace(dbA: Database, dbB: Database): Promise<void> {
  const setupService = new AccessService(dbA, new AccessRepository(dbA));
  const scenario = await seedBase(dbA, setupService);
  const membership = await setupService.requestClassMembership(
    scenario.guardian,
    scenario.createdClass.inviteCode,
    scenario.student.id,
  );
  const previewed = deferred();
  const allowApproveLock = deferred();
  const approveLockAttempted = deferred();

  class PausedApproveRepository extends AccessRepository {
    override async findMembershipForTransition(
      transaction: AccessTransaction,
      membershipId: string,
    ): Promise<ClassMembership | undefined> {
      const preview = await super.findMembershipForTransition(transaction, membershipId);
      previewed.resolve();
      await allowApproveLock.promise;
      return preview;
    }

    override async lockActiveGuardianLink(
      transaction: AccessTransaction,
      guardianUserId: string,
      studentProfileId: string,
    ): Promise<boolean> {
      approveLockAttempted.resolve();
      return super.lockActiveGuardianLink(transaction, guardianUserId, studentProfileId);
    }
  }

  const approveService = new AccessService(dbA, new PausedApproveRepository(dbA));
  const approve = approveService.approveClassMembership(scenario.guardian, membership.id);
  const approveOutcome = Promise.allSettled([approve]);
  await previewed.promise;

  const linkLocked = deferred();
  const allowRevokeCommit = deferred();
  const revoke = dbB.transaction(async (transaction) => {
    const [link] = await transaction
      .select({ id: guardianLinks.id })
      .from(guardianLinks)
      .where(and(
        eq(guardianLinks.guardianUserId, scenario.guardian.userId),
        eq(guardianLinks.studentProfileId, scenario.student.id),
        isNull(guardianLinks.revokedAt),
      ))
      .for("update");
    assert.ok(link);
    linkLocked.resolve();
    await allowRevokeCommit.promise;
    await transaction
      .update(guardianLinks)
      .set({ revokedAt: new Date() })
      .where(eq(guardianLinks.id, link.id));
  });
  await linkLocked.promise;
  allowApproveLock.resolve();
  await approveLockAttempted.promise;
  allowRevokeCommit.resolve();
  await revoke;

  const [outcome] = await approveOutcome;
  assert.equal(outcome?.status, "rejected");
  if (outcome?.status === "rejected") {
    assert.equal((outcome.reason as { statusCode?: number }).statusCode, 403);
  }
  const [finalMembership] = await dbA
    .select({ state: classMemberships.state })
    .from(classMemberships)
    .where(eq(classMemberships.id, membership.id));
  assert.equal(finalMembership?.state, "requested");
  const [grantCount] = await dbA
    .select({ value: count() })
    .from(dataSharingGrants)
    .where(eq(dataSharingGrants.classMembershipId, membership.id));
  assert.equal(grantCount?.value, 0);
  const [approvalAuditCount] = await dbA
    .select({ value: count() })
    .from(auditEvents)
    .where(and(
      eq(auditEvents.subjectId, membership.id),
      eq(auditEvents.action, "class.membership.approved"),
    ));
  assert.equal(approvalAuditCount?.value, 0);
}

const dbA = createDb(connectionString);
const dbB = createDb(connectionString);
assert.notEqual(dbA.$client, dbB.$client);

try {
  await migrateDb(dbA);
  await duplicateRequestRace(dbA, dbB);
  await approveRejectRace(dbA, dbB);
  await guardianRevokeApproveRace(dbA, dbB);
} finally {
  await Promise.all([dbA.$client.end(), dbB.$client.end()]);
}
