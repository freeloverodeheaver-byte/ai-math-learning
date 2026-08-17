import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ForbiddenError, requireActor } from "../../plugins/actor.js";
import { decideStudentRead } from "./policy.js";
import type { AccessRepository } from "./repository.js";
import type { AccessService } from "./service.js";

const StudentBodySchema = z.strictObject({
  studentExternalSubject: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  grade: z.union([z.literal(7), z.literal(8), z.literal(9)]),
  semester: z.union([z.literal(1), z.literal(2)]),
});

const ClassBodySchema = z.strictObject({
  name: z.string().trim().min(1),
  subject: z.literal("math"),
});

const JoinBodySchema = z.strictObject({
  inviteCode: z.string().trim().min(1),
  studentId: z.uuid(),
});

const MembershipParamsSchema = z.strictObject({ membershipId: z.uuid() });
const EmptyTransitionBodySchema = z.union([z.undefined(), z.strictObject({})]);
const SharingParamsSchema = z.strictObject({
  studentId: z.uuid(),
  scope: z.enum(["learning_summary", "shared_personal_content"]),
});

class BadRequestError extends Error {
  readonly code = "BAD_REQUEST";
  readonly statusCode = 400;

  constructor() {
    super("BAD_REQUEST");
    this.name = "BadRequestError";
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestError();
  return parsed.data;
}

export interface AccessRoutesOptions {
  service: AccessService;
  repository: AccessRepository;
}

export const registerAccessRoutes: FastifyPluginAsync<AccessRoutesOptions> = async (
  app,
  options,
) => {
  app.post("/access/students", async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(StudentBodySchema, request.body);
    return reply.code(201).send(await options.service.createStudentForGuardian(actor, input));
  });

  app.post("/access/classes", async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(ClassBodySchema, request.body);
    return reply.code(201).send(await options.service.createClass(actor, input));
  });

  app.post("/access/classes/join", async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(JoinBodySchema, request.body);
    return reply.code(201).send(await options.service.requestClassMembership(
      actor,
      input.inviteCode,
      input.studentId,
    ));
  });

  app.post("/access/class-memberships/:membershipId/approve", async (request) => {
    const actor = requireActor(request);
    const { membershipId } = parse(MembershipParamsSchema, request.params);
    parse(EmptyTransitionBodySchema, request.body);
    return options.service.approveClassMembership(actor, membershipId);
  });

  app.post("/access/class-memberships/:membershipId/reject", async (request) => {
    const actor = requireActor(request);
    const { membershipId } = parse(MembershipParamsSchema, request.params);
    parse(EmptyTransitionBodySchema, request.body);
    return options.service.rejectClassMembership(actor, membershipId);
  });

  app.post("/access/class-memberships/:membershipId/revoke", async (request) => {
    const actor = requireActor(request);
    const { membershipId } = parse(MembershipParamsSchema, request.params);
    parse(EmptyTransitionBodySchema, request.body);
    return options.service.revokeClassMembership(actor, membershipId);
  });

  app.get("/access/class-memberships/:membershipId", async (request) => {
    const actor = requireActor(request);
    const { membershipId } = parse(MembershipParamsSchema, request.params);
    return options.service.getClassMembershipForTeacher(actor, membershipId);
  });

  app.get("/access/students/:studentId/sharing/:scope", async (request) => {
    const actor = requireActor(request);
    const { studentId, scope } = parse(SharingParamsSchema, request.params);
    const decision = await decideStudentRead(options.repository, actor, studentId, scope);
    if (!decision.allowed) throw new ForbiddenError();
    return decision;
  });
};
