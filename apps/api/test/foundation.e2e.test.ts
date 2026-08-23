import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { ContentBundleSchema, type Actor, type ContentBundle, type Role } from "@math/contracts";
import {
  auditEvents,
  classes,
  classMemberships,
  contentBundles,
  contentBundleVersions,
  contentEntityOwners,
  dataSharingGrants,
  guardianLinks,
  knowledgePointVersions,
  knowledgePoints,
  knowledgePrerequisites,
  questionKnowledgePoints,
  questionVersions,
  questions,
  sources,
  studentProfiles,
  teacherProfiles,
  userRoles,
  users,
} from "@math/db";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { FastifyInstance } from "fastify";
import { expect, it } from "vitest";
import { buildProductionApp } from "../src/composition.js";

const schema = {
  auditEvents,
  classes,
  classMemberships,
  contentBundles,
  contentBundleVersions,
  contentEntityOwners,
  dataSharingGrants,
  guardianLinks,
  knowledgePointVersions,
  knowledgePoints,
  knowledgePrerequisites,
  questionKnowledgePoints,
  questionVersions,
  questions,
  sources,
  studentProfiles,
  teacherProfiles,
  userRoles,
  users,
};

function headers(actor: Actor): Record<string, string> {
  return {
    "x-dev-user-id": actor.userId,
    "x-dev-roles": actor.roles.join(","),
  };
}

async function applyCommittedMigrations(pglite: PGlite): Promise<void> {
  const migrations = new URL("../../../packages/db/migrations/", import.meta.url);
  const journal = JSON.parse(
    await readFile(new URL("meta/_journal.json", migrations), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  for (const entry of journal.entries) {
    await pglite.exec(await readFile(new URL(`${entry.tag}.sql`, migrations), "utf8"));
  }
}

it("accepts the complete audited content and guardian-approved class-sharing foundation slice", async () => {
  const pglite = await PGlite.create({ extensions: { pgcrypto } });
  let app: FastifyInstance | undefined;
  try {
    await applyCommittedMigrations(pglite);
    const database = Object.assign(drizzle(pglite, { schema }), {
      $client: { end: () => pglite.close() },
    });
    const operator = { userId: randomUUID(), roles: ["operator"] } satisfies Actor;
    const guardian = { userId: randomUUID(), roles: ["guardian"] } satisfies Actor;
    const teacher = { userId: randomUUID(), roles: ["teacher"] } satisfies Actor;
    const unrelatedTeacher = { userId: randomUUID(), roles: ["teacher"] } satisfies Actor;
    const actors = [operator, guardian, teacher, unrelatedTeacher];

    await database.insert(users).values(actors.map((actor) => ({
      id: actor.userId,
      externalSubject: `foundation-${actor.userId}`,
    })));
    await database.insert(userRoles).values(actors.flatMap((actor) =>
      actor.roles.map((role: Role) => ({ userId: actor.userId, role })),
    ));
    await database.insert(teacherProfiles).values([
      { userId: teacher.userId, displayName: "Foundation teacher" },
      { userId: unrelatedTeacher.userId, displayName: "Unrelated teacher" },
    ]);

    app = await buildProductionApp({
      config: {
        NODE_ENV: "test",
        PORT: 3000,
        DEV_IDENTITY_ENABLED: true,
      },
      database,
    });

    const committedBundleUrl = new URL(
      "../../../seed/mock-content-grade-7-semester-1.json",
      import.meta.url,
    );
    const committedBundle = ContentBundleSchema.parse(
      JSON.parse(await readFile(committedBundleUrl, "utf8")),
    );
    const historicalBundle: ContentBundle = {
      ...committedBundle,
      version: 1,
      questions: committedBundle.questions.map((question) => ({
        ...question,
        stem: `Historical: ${question.stem}`,
      })),
    };
    for (const payload of [historicalBundle, committedBundle]) {
      const imported = await app.inject({
        method: "POST",
        url: "/operator/content/bundles/import",
        headers: headers(operator),
        payload,
      });
      expect(imported.statusCode).toBe(201);
    }

    const studentResponse = await app.inject({
      method: "POST",
      url: "/access/students",
      headers: headers(guardian),
      payload: {
        studentExternalSubject: `foundation-student-${randomUUID()}`,
        displayName: "Foundation student",
        grade: 7,
        semester: 1,
      },
    });
    expect(studentResponse.statusCode).toBe(201);
    const student = studentResponse.json<{ id: string }>();

    const classResponse = await app.inject({
      method: "POST",
      url: "/access/classes",
      headers: headers(teacher),
      payload: { name: "Foundation grade 7 math", subject: "math" },
    });
    expect(classResponse.statusCode).toBe(201);
    const createdClass = classResponse.json<{ id: string; inviteCode: string }>();
    expect(createdClass.inviteCode).toEqual(expect.any(String));

    const joinResponse = await app.inject({
      method: "POST",
      url: "/access/classes/join",
      headers: headers(guardian),
      payload: { inviteCode: createdClass.inviteCode, studentId: student.id },
    });
    expect(joinResponse.statusCode).toBe(201);
    const membership = joinResponse.json<{ id: string }>();

    for (const actor of [teacher, unrelatedTeacher]) {
      const response = await app.inject({
        method: "GET",
        url: `/access/students/${student.id}/sharing/learning_summary`,
        headers: headers(actor),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: "FORBIDDEN" });
    }

    const approval = await app.inject({
      method: "POST",
      url: `/access/class-memberships/${membership.id}/approve`,
      headers: headers(guardian),
    });
    expect(approval.statusCode).toBe(200);

    const approvedLearning = await app.inject({
      method: "GET",
      url: `/access/students/${student.id}/sharing/learning_summary`,
      headers: headers(teacher),
    });
    expect(approvedLearning.statusCode).toBe(200);
    const privateContent = await app.inject({
      method: "GET",
      url: `/access/students/${student.id}/sharing/shared_personal_content`,
      headers: headers(teacher),
    });
    expect(privateContent.statusCode).toBe(403);
    expect(privateContent.json()).toEqual({ code: "FORBIDDEN" });
    const unrelatedLearning = await app.inject({
      method: "GET",
      url: `/access/students/${student.id}/sharing/learning_summary`,
      headers: headers(unrelatedTeacher),
    });
    expect(unrelatedLearning.statusCode).toBe(403);
    expect(unrelatedLearning.json()).toEqual({ code: "FORBIDDEN" });

    const unauthenticatedQuestions = await app.inject({
      method: "GET",
      url: "/operator/content/questions/published",
    });
    expect(unauthenticatedQuestions.statusCode).toBe(401);
    const teacherQuestions = await app.inject({
      method: "GET",
      url: "/operator/content/questions/published",
      headers: headers(teacher),
    });
    expect(teacherQuestions.statusCode).toBe(403);
    expect(teacherQuestions.json()).toEqual({ code: "FORBIDDEN" });
    const operatorQuestions = await app.inject({
      method: "GET",
      url: "/operator/content/questions/published",
      headers: headers(operator),
    });
    expect(operatorQuestions.statusCode).toBe(200);
    expect(operatorQuestions.json()).toEqual({
      questions: committedBundle.questions.map((question) => ({
        externalKey: question.externalKey,
        version: committedBundle.version,
        stem: question.stem,
        answer: question.answer,
        explanation: question.explanation,
        difficulty: question.difficulty,
      })),
    });

    const actions = [
      "content.bundle.imported",
      "content.bundle.published",
      "student.created",
      "class.created",
      "class.membership.requested",
      "class.membership.approved",
    ];
    const durableAudits = await database.select({
      actorUserId: auditEvents.actorUserId,
      action: auditEvents.action,
      subjectId: auditEvents.subjectId,
    }).from(auditEvents).where(inArray(auditEvents.action, actions));
    expect(durableAudits).toEqual(expect.arrayContaining([
      { actorUserId: operator.userId, action: "content.bundle.imported", subjectId: committedBundle.bundleId },
      { actorUserId: operator.userId, action: "content.bundle.published", subjectId: committedBundle.bundleId },
      { actorUserId: guardian.userId, action: "student.created", subjectId: student.id },
      { actorUserId: teacher.userId, action: "class.created", subjectId: createdClass.id },
      { actorUserId: guardian.userId, action: "class.membership.requested", subjectId: membership.id },
      { actorUserId: guardian.userId, action: "class.membership.approved", subjectId: membership.id },
    ]));
  } finally {
    if (app === undefined) await pglite.close();
    else await app.close();
  }
});
