# Content, Identity, and Authorization Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first independently testable product slice: a modular TypeScript API that can import versioned mock math content, create family and class relationships, and enforce student-data authorization with audit records.

**Architecture:** Use a pnpm monorepo with a Fastify modular-monolith API, shared Zod contracts, and a PostgreSQL data package built with Drizzle ORM. Keep authentication provider details behind an adapter; this phase uses a deterministic development/test identity provider while establishing the production-facing actor and permission interfaces.

**Tech Stack:** Node.js, TypeScript, pnpm workspaces, Fastify, Zod, Drizzle ORM, PostgreSQL, Vitest, Supertest-compatible Fastify injection, Docker Compose for the local database.

## Global Constraints

- The product covers junior-middle-school mathematics for grades 7–9 only.
- The primary client will be a WeChat Mini Program; the operations client will be responsive Web.
- Mock knowledge and question content must use the same schema and import API as formal content.
- Published training questions must have a knowledge-point link, answer, explanation, source record, and review state.
- AI-generated questions are not accepted as published training content in MVP.
- Parent, student, teacher, and operator access must be isolated by explicit role and sharing grants.
- A teacher may read only authorized learning results and explicitly shared student content.
- Every permission, content publication, and reward-relevant change must be auditable.
- The full MVP targets a 10–12 week pilot; this plan covers only the first 1–2 week foundation slice.
- Use TDD for every behavior and commit after each independently reviewable task.

---

## Plan Set and Phase Boundary

The confirmed product specification is too large for one safe implementation plan. Execute it as six dependent slices:

1. **Content, identity, and authorization foundation** — this document.
2. Capture, OCR confirmation, and personal knowledge/question libraries.
3. Review scheduling, similarity retrieval, mastery, and rank progression.
4. Review-pack PDF generation and paper-result return.
5. Parent and teacher user experiences.
6. Feedback rewards, pilot hardening, analytics, and acceptance testing.

This plan ends when the API can complete one tested vertical slice: an operator publishes mock content, a guardian creates a student, a teacher creates a class, the guardian approves membership, and authorization prevents unrelated users from reading the student.

## Target File Map

```text
project1/
├─ package.json                         # Workspace scripts only
├─ pnpm-workspace.yaml                  # Workspace package discovery
├─ tsconfig.base.json                   # Shared strict TypeScript settings
├─ .env.example                         # Required local environment names
├─ infra/
│  └─ compose.yaml                      # Local PostgreSQL service
├─ packages/
│  ├─ contracts/
│  │  ├─ package.json
│  │  └─ src/
│  │     ├─ actor.ts                    # Actor and role contracts
│  │     ├─ content.ts                  # Import bundle contracts
│  │     └─ index.ts                    # Public exports
│  └─ db/
│     ├─ package.json
│     ├─ drizzle.config.ts
│     ├─ migrations/                    # Generated SQL migrations
│     └─ src/
│        ├─ client.ts                   # Database construction
│        ├─ migrate.ts                  # Migration entry point
│        ├─ schema/
│        │  ├─ identity.ts              # Users, profiles, links, classes
│        │  ├─ content.ts               # Knowledge and question versions
│        │  ├─ audit.ts                 # Append-only audit events
│        │  └─ index.ts
│        └─ index.ts
├─ apps/
│  └─ api/
│     ├─ package.json
│     ├─ tsconfig.json
│     ├─ src/
│     │  ├─ app.ts                      # Fastify composition root
│     │  ├─ main.ts                     # Process entry point
│     │  ├─ config.ts                   # Validated environment
│     │  ├─ plugins/
│     │  │  ├─ actor.ts                 # Identity adapter integration
│     │  │  └─ db.ts                    # Database decoration
│     │  └─ modules/
│     │     ├─ health/routes.ts
│     │     ├─ content/
│     │     │  ├─ repository.ts
│     │     │  ├─ service.ts
│     │     │  └─ routes.ts
│     │     ├─ identity/
│     │     │  ├─ identity-provider.ts
│     │     │  └─ dev-identity-provider.ts
│     │     ├─ access/
│     │     │  ├─ policy.ts
│     │     │  └─ routes.ts
│     │     └─ audit/service.ts
│     └─ test/
│        ├─ health.test.ts
│        ├─ content-import.test.ts
│        ├─ actor-policy.test.ts
│        ├─ family-class-access.test.ts
│        └─ foundation.e2e.test.ts
└─ seed/
   └─ mock-content-grade-7-semester-1.json
```

## Shared Interfaces

All later tasks use these names exactly:

```ts
export type Role = "student" | "guardian" | "teacher" | "operator";

export const RoleSchema = z.enum(["student", "guardian", "teacher", "operator"]);

export interface Actor {
  userId: string;
  roles: readonly Role[];
}

export interface KnowledgePointInput {
  canonicalId: string;
  name: string;
  grade: 7 | 8 | 9;
  semester: 1 | 2;
  prerequisites: string[];
}

export interface QuestionInput {
  externalKey: string;
  stem: string;
  answer: string;
  explanation: string;
  knowledgeCanonicalIds: string[];
  difficulty: 1 | 2 | 3 | 4 | 5;
  sourceLabel: string;
}

export interface ContentBundle {
  bundleId: string;
  version: number;
  knowledgePoints: KnowledgePointInput[];
  questions: QuestionInput[];
}

export interface SharingDecision {
  allowed: boolean;
  reason:
    | "self"
    | "guardian_link"
    | "class_grant"
    | "operator"
    | "not_authorized";
}
```

### Task 1: Workspace and API Test Harness

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.env.example`
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/main.ts`
- Create: `apps/api/src/config.ts`
- Create: `apps/api/src/modules/health/routes.ts`
- Test: `apps/api/test/health.test.ts`

**Interfaces:**
- Produces: `buildApp(options?: BuildAppOptions): Promise<FastifyInstance>`.
- Produces: `loadConfig(env: NodeJS.ProcessEnv): AppConfig`.
- Consumes: no earlier task interfaces.

- [ ] **Step 1: Create the workspace manifests and install the minimum API/test dependencies**

```json
{
  "name": "ai-math-learning-product",
  "private": true,
  "packageManager": "pnpm@10",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  }
}
```

```yaml
packages:
  - apps/*
  - packages/*
```

Run:

```bash
pnpm --dir apps/api add fastify zod
pnpm --dir apps/api add -D typescript tsx vitest @types/node
pnpm install
```

- [ ] **Step 2: Write the failing health-route test**

```ts
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";

describe("GET /health", () => {
  it("returns a deterministic readiness payload", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "api" });
    await app.close();
  });
});
```

- [ ] **Step 3: Run the test and verify the expected failure**

Run: `pnpm --filter @math/api test -- health.test.ts`

Expected: FAIL because `../src/app` or `buildApp` does not exist.

- [ ] **Step 4: Implement the minimal Fastify composition root and validated config**

```ts
import Fastify from "fastify";
import { registerHealthRoutes } from "./modules/health/routes";

export async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(registerHealthRoutes);
  return app;
}
```

```ts
import type { FastifyPluginAsync } from "fastify";

export const registerHealthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => ({ status: "ok", service: "api" }));
};
```

Config must validate `NODE_ENV`, `DATABASE_URL`, `PORT`, and `DEV_IDENTITY_ENABLED` with Zod. Tests may use `NODE_ENV=test` and an injected database; production startup must reject a missing `DATABASE_URL`.

- [ ] **Step 5: Run health, typecheck, and build verification**

Run: `pnpm --filter @math/api test -- health.test.ts`

Expected: PASS, 1 test.

Run: `pnpm --filter @math/api typecheck`

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 6: Commit the workspace slice**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .env.example apps/api
git commit -m "build: scaffold modular API workspace"
```

### Task 2: PostgreSQL Schema and Migration Harness

**Files:**
- Create: `infra/compose.yaml`
- Create: `packages/db/package.json`
- Create: `packages/db/drizzle.config.ts`
- Create: `packages/db/src/client.ts`
- Create: `packages/db/src/migrate.ts`
- Create: `packages/db/src/schema/identity.ts`
- Create: `packages/db/src/schema/content.ts`
- Create: `packages/db/src/schema/audit.ts`
- Create: `packages/db/src/schema/index.ts`
- Create: `packages/db/src/index.ts`
- Create: `packages/db/migrations/0000_foundation.sql`
- Test: `packages/db/test/schema.integration.test.ts`

**Interfaces:**
- Produces: `createDb(connectionString: string): Database`.
- Produces: `migrateDb(db: Database): Promise<void>`.
- Produces tables for users, profiles, links, classes, grants, knowledge versions, question versions, sources, and audit events.
- Consumes: role strings defined in Shared Interfaces.

- [ ] **Step 1: Add database dependencies and local PostgreSQL service**

```bash
pnpm --dir packages/db add drizzle-orm pg
pnpm --dir packages/db add -D drizzle-kit @types/pg typescript vitest
```

Create `infra/compose.yaml` with PostgreSQL, database `math_learning`, user `math_app`, a health check using `pg_isready`, and a named volume. Bind only to `127.0.0.1:5432`.

- [ ] **Step 2: Write the failing schema integration test**

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, migrateDb } from "../src";
import { randomUUID } from "node:crypto";
import { knowledgePoints, knowledgePrerequisites, questionVersions, questions } from "../src/schema";

const db = createDb(process.env.TEST_DATABASE_URL!);

beforeAll(async () => migrateDb(db));

describe("foundation schema", () => {
  it("keeps a stable question id while content versions change", async () => {
    const [question] = await db.insert(questions).values({ externalKey: "mock-q-001" }).returning();
    await db.insert(questionVersions).values([
      { questionId: question.id, version: 1, stem: "1+1=?", answer: "2", explanation: "Add one and one.", reviewState: "published" },
      { questionId: question.id, version: 2, stem: "1+1 等于多少？", answer: "2", explanation: "一与一相加。", reviewState: "draft" }
    ]);

    const rows = await db.select().from(questionVersions);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.questionId))).toEqual(new Set([question.id]));
  });

  it("rejects a prerequisite that does not target a known knowledge point", async () => {
    const [point] = await db.insert(knowledgePoints).values({
      canonicalId: "g7.valid",
      name: "Valid",
      grade: 7,
      semester: 1
    }).returning();

    await expect(
      db.insert(knowledgePrerequisites).values({
        knowledgePointId: point.id,
        prerequisiteKnowledgePointId: randomUUID()
      })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run the integration test and verify it fails before schema creation**

Run: `docker compose -f infra/compose.yaml up -d postgres`

Run: `pnpm --filter @math/db test -- schema.integration.test.ts`

Expected: FAIL because the database package, migration, or tables do not exist.

- [ ] **Step 4: Implement normalized identity, content-version, and audit tables**

The first migration must create these keys and constraints:

```sql
create extension if not exists pgcrypto;
create type app_role as enum ('student', 'guardian', 'teacher', 'operator');
create type review_state as enum ('draft', 'in_review', 'published', 'retired');

create table users (
  id uuid primary key default gen_random_uuid(),
  external_subject text not null unique,
  created_at timestamptz not null default now()
);

create table knowledge_points (
  id uuid primary key default gen_random_uuid(),
  canonical_id text not null unique,
  name text not null,
  grade smallint not null check (grade between 7 and 9),
  semester smallint not null check (semester in (1, 2))
);

create table questions (
  id uuid primary key default gen_random_uuid(),
  external_key text not null unique
);

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references users(id),
  action text not null,
  subject_type text not null,
  subject_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

Add separate version tables, source records, many-to-many question knowledge links, user roles, student profiles, guardian links, teacher profiles, classes, class memberships, and data-sharing grants. Add unique constraints for `(question_id, version)`, `(knowledge_point_id, version)`, active guardian links, and active class memberships.

- [ ] **Step 5: Run migrations and verify all database tests pass**

Run: `pnpm --filter @math/db migrate`

Expected: migration applies once; a second run exits 0 without changes.

Run: `pnpm --filter @math/db test`

Expected: all schema integration tests pass.

- [ ] **Step 6: Commit the database foundation**

```bash
git add infra packages/db
git commit -m "feat: add versioned content and identity schema"
```

### Task 3: Versioned Mock-Content Import

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/src/content.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `seed/mock-content-grade-7-semester-1.json`
- Create: `apps/api/src/modules/content/repository.ts`
- Create: `apps/api/src/modules/content/service.ts`
- Test: `apps/api/test/content-import.test.ts`

**Interfaces:**
- Produces: `ContentBundleSchema` and inferred `ContentBundle`.
- Produces: `ContentService.importBundle(bundle, actor, transaction?): Promise<ImportResult>`; it opens a transaction only when the caller does not provide one.
- Produces: repository primitives `findBundleVersion`, `upsertStableKnowledgePoint`, `upsertStableQuestion`, `appendKnowledgeVersion`, and `appendQuestionVersion`, all accepting the transaction passed by `ContentService`.
- Produces: `ImportResult = { createdKnowledge: number; createdQuestions: number; newVersions: number; unchanged: number }`.
- Consumes: database version and source tables from Task 2.

- [ ] **Step 1: Write the failing bundle-validation tests**

```ts
import { describe, expect, it } from "vitest";
import { ContentBundleSchema } from "@math/contracts";

describe("ContentBundleSchema", () => {
  it("accepts complete mock content", () => {
    const parsed = ContentBundleSchema.parse({
      bundleId: "mock-g7-s1",
      version: 1,
      knowledgePoints: [{ canonicalId: "g7s1.rational", name: "有理数", grade: 7, semester: 1, prerequisites: [] }],
      questions: [{
        externalKey: "mock-q-001",
        stem: "计算：-2+5",
        answer: "3",
        explanation: "异号相加，取绝对值较大数的符号。",
        knowledgeCanonicalIds: ["g7s1.rational"],
        difficulty: 1,
        sourceLabel: "MVP simulated content"
      }]
    });

    expect(parsed.questions[0].externalKey).toBe("mock-q-001");
  });

  it("rejects a question without answer or explanation", () => {
    const invalid = { bundleId: "bad", version: 1, knowledgePoints: [], questions: [{ externalKey: "q" }] };
    expect(() => ContentBundleSchema.parse(invalid)).toThrow();
  });
});
```

- [ ] **Step 2: Run the contract tests and verify they fail**

Run: `pnpm --filter @math/contracts test`

Expected: FAIL because `ContentBundleSchema` does not exist.

- [ ] **Step 3: Implement strict Zod contracts and a referential-integrity preflight**

```ts
export const ContentBundleSchema = z.object({
  bundleId: z.string().min(1),
  version: z.number().int().positive(),
  knowledgePoints: z.array(KnowledgePointInputSchema).min(1),
  questions: z.array(QuestionInputSchema).min(1)
}).superRefine((bundle, context) => {
  const ids = new Set(bundle.knowledgePoints.map((item) => item.canonicalId));
  for (const question of bundle.questions) {
    for (const id of question.knowledgeCanonicalIds) {
      if (!ids.has(id)) context.addIssue({ code: "custom", message: `Unknown knowledge point: ${id}` });
    }
  }
});
```

The importer must execute in one transaction, create stable entities by `canonicalId` or `externalKey`, append a version only when versioned fields changed, and reject version regression. Task 6 supplies a transaction and appends `content.bundle.imported` in that same transaction; Task 3 must not write an audit event directly.

- [ ] **Step 4: Write the failing idempotency and replacement tests**

```ts
it("imports the same bundle twice without duplicate versions", async () => {
  const first = await service.importBundle(bundle, operator);
  const second = await service.importBundle(bundle, operator);

  expect(first.createdQuestions).toBe(1);
  expect(second).toEqual({ createdKnowledge: 0, createdQuestions: 0, newVersions: 0, unchanged: 2 });
});

it("adds a new version while retaining the stable external key", async () => {
  await service.importBundle(bundle, operator);
  const changed = { ...bundle, version: 2, questions: [{ ...bundle.questions[0], stem: "计算并说明：-2+5" }] };
  const result = await service.importBundle(changed, operator);

  expect(result.newVersions).toBe(1);
  expect(await repository.versionCount("mock-q-001")).toBe(2);
});
```

- [ ] **Step 5: Run content tests and import the seed bundle**

Run: `pnpm --filter @math/api test -- content-import.test.ts`

Expected: all validation, idempotency, and version-retention tests pass.

Run: `pnpm --filter @math/api seed -- ../../seed/mock-content-grade-7-semester-1.json`

Expected: output reports nonzero created counts on the first run and only unchanged counts on the second run.

- [ ] **Step 6: Commit versioned mock-content import**

```bash
git add packages/contracts seed apps/api/src/modules/content apps/api/test/content-import.test.ts
git commit -m "feat: import versioned mock math content"
```

### Task 4: Actor Resolution and Role Enforcement

**Files:**
- Create: `packages/contracts/src/actor.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/modules/identity/identity-provider.ts`
- Create: `apps/api/src/modules/identity/dev-identity-provider.ts`
- Create: `apps/api/src/plugins/actor.ts`
- Test: `apps/api/test/actor-policy.test.ts`

**Interfaces:**
- Produces: `IdentityProvider.resolve(request): Promise<Actor | null>`.
- Produces: `requireActor(request): Actor`.
- Produces: `requireRole(actor, allowedRoles): void`, throwing `ForbiddenError` for mismatches.
- Consumes: `Actor` and `Role` from Shared Interfaces.

- [ ] **Step 1: Write failing role-enforcement tests**

```ts
import { describe, expect, it } from "vitest";
import { requireRole } from "../src/plugins/actor";

describe("requireRole", () => {
  it("allows an operator to call operator routes", () => {
    expect(() => requireRole({ userId: "u1", roles: ["operator"] }, ["operator"])).not.toThrow();
  });

  it("rejects a teacher on operator-only routes", () => {
    expect(() => requireRole({ userId: "u2", roles: ["teacher"] }, ["operator"])).toThrowError("FORBIDDEN");
  });
});
```

- [ ] **Step 2: Run the test and verify the missing-policy failure**

Run: `pnpm --filter @math/api test -- actor-policy.test.ts`

Expected: FAIL because actor contracts and `requireRole` do not exist.

- [ ] **Step 3: Implement the identity-provider boundary and development provider**

```ts
export interface IdentityProvider {
  resolve(request: FastifyRequest): Promise<Actor | null>;
}

export class DevIdentityProvider implements IdentityProvider {
  async resolve(request: FastifyRequest): Promise<Actor | null> {
    const userId = request.headers["x-dev-user-id"];
    const roles = request.headers["x-dev-roles"];
    if (typeof userId !== "string" || typeof roles !== "string") return null;
    return { userId, roles: z.array(RoleSchema).parse(roles.split(",")) };
  }
}
```

The plugin must refuse to start with `DevIdentityProvider` when `NODE_ENV=production` or `DEV_IDENTITY_ENABLED=false`. Do not implement WeChat login in this phase; later code must replace the adapter without changing `Actor` or policy interfaces.

- [ ] **Step 4: Add route-level 401 and 403 tests**

Test an operator-only probe route with no actor headers, teacher headers, and operator headers. Expected statuses are 401, 403, and 200 respectively.

- [ ] **Step 5: Run role and full API tests**

Run: `pnpm --filter @math/api test -- actor-policy.test.ts`

Expected: all actor resolution and role tests pass.

Run: `pnpm --filter @math/api typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit identity boundaries**

```bash
git add packages/contracts/src apps/api/src/modules/identity apps/api/src/plugins/actor.ts apps/api/test/actor-policy.test.ts
git commit -m "feat: enforce actor roles through identity adapter"
```

### Task 5: Family, Class, and Student-Sharing Authorization

**Files:**
- Create: `apps/api/src/modules/access/policy.ts`
- Create: `apps/api/src/modules/access/service.ts`
- Create: `apps/api/src/modules/access/routes.ts`
- Test: `apps/api/test/family-class-access.test.ts`

**Interfaces:**
- Produces: `decideStudentRead(actor, studentId, scope): Promise<SharingDecision>`.
- Produces: `createStudentForGuardian(actor, input): Promise<StudentProfile>`.
- Produces: `createClass(actor, input): Promise<Class>`.
- Produces: `requestClassMembership(actor, inviteCode, studentId): Promise<ClassMembership>`.
- Produces: `approveClassMembership(actor, membershipId): Promise<DataSharingGrant>`.
- Consumes: actor plugin from Task 4 and identity tables from Task 2.

- [ ] **Step 1: Write the failing authorization-matrix tests**

```ts
describe("student read policy", () => {
  it.each([
    ["student self", studentActor, studentId, true, "self"],
    ["linked guardian", guardianActor, studentId, true, "guardian_link"],
    ["approved class teacher", teacherActor, studentId, true, "class_grant"],
    ["unrelated teacher", unrelatedTeacher, studentId, false, "not_authorized"],
    ["unrelated guardian", unrelatedGuardian, studentId, false, "not_authorized"],
    ["operator", operatorActor, studentId, true, "operator"]
  ])("%s", async (_name, actor, target, allowed, reason) => {
    await expect(policy.decideStudentRead(actor, target, "learning_summary")).resolves.toEqual({ allowed, reason });
  });
});
```

- [ ] **Step 2: Run the matrix and verify it fails without policy implementation**

Run: `pnpm --filter @math/api test -- family-class-access.test.ts`

Expected: FAIL because access policy and setup services do not exist.

- [ ] **Step 3: Implement minimum-privilege decisions**

```ts
export async function decideStudentRead(
  repositories: AccessRepositories,
  actor: Actor,
  studentId: string,
  scope: "learning_summary" | "shared_personal_content"
): Promise<SharingDecision> {
  if (actor.roles.includes("operator")) return { allowed: true, reason: "operator" };
  if (actor.roles.includes("student") && await repositories.isStudentUser(actor.userId, studentId)) {
    return { allowed: true, reason: "self" };
  }
  if (await repositories.hasActiveGuardianLink(actor.userId, studentId)) return { allowed: true, reason: "guardian_link" };
  if (await repositories.hasActiveClassGrant(actor.userId, studentId, scope)) return { allowed: true, reason: "class_grant" };
  return { allowed: false, reason: "not_authorized" };
}
```

- [ ] **Step 4: Implement the guardian-approval class flow and route tests**

Required state transitions:

```text
requested -> active
requested -> rejected
active -> revoked
```

Only the linked guardian may approve, reject, or revoke. Approval changes `requested` directly to `active` and creates the sharing grant in the same transaction. A teacher may issue an invite and see request status but cannot activate sharing. Every transition appends an audit event containing membership ID, student profile ID, class ID, old state, and new state.

- [ ] **Step 5: Run permission, integration, and type tests**

Run: `pnpm --filter @math/api test -- family-class-access.test.ts`

Expected: every matrix row and membership transition passes.

Run: `pnpm --filter @math/api test`

Expected: all API tests pass; unrelated actor requests return 403 and do not reveal whether the student exists.

- [ ] **Step 6: Commit family and class authorization**

```bash
git add apps/api/src/modules/access apps/api/test/family-class-access.test.ts
git commit -m "feat: add guardian-approved class data sharing"
```

### Task 6: Audit Service and Operator Content API

**Files:**
- Create: `apps/api/src/modules/audit/service.ts`
- Create: `apps/api/src/modules/content/routes.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/operator-content-api.test.ts`

**Interfaces:**
- Produces: `AuditService.record(transaction, event: AuditEventInput): Promise<void>`.
- Produces routes: `POST /operator/content/bundles/validate` and `POST /operator/content/bundles/import`.
- Consumes: `ContentBundleSchema`, `ContentService.importBundle`, `requireRole`, and the audit table.

- [ ] **Step 1: Write failing operator API tests**

```ts
it("validates without persisting", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/operator/content/bundles/validate",
    headers: operatorHeaders,
    payload: bundle
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ valid: true, knowledgePoints: 1, questions: 1 });
  expect(await repository.bundleCount()).toBe(0);
});

it("imports and records the actor in audit history", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/operator/content/bundles/import",
    headers: operatorHeaders,
    payload: bundle
  });

  expect(response.statusCode).toBe(201);
  expect(await audit.findByAction("content.bundle.imported")).toContainEqual(
    expect.objectContaining({ actorUserId: operatorHeaders["x-dev-user-id"] })
  );
});
```

- [ ] **Step 2: Run the API tests and verify route-not-found failures**

Run: `pnpm --filter @math/api test -- operator-content-api.test.ts`

Expected: FAIL with 404 responses.

- [ ] **Step 3: Implement append-only audit and operator routes**

```ts
export interface AuditEventInput {
  actorUserId: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  metadata: Record<string, unknown>;
}

export class AuditService {
  constructor(private readonly repository: AuditRepository) {}
  record(transaction: DatabaseTransaction, event: AuditEventInput) {
    return this.repository.append(transaction, event);
  }
}
```

Validation must return structured Zod issues without persisting. Import must require the operator role and run one `db.transaction` callback that passes `transaction` to both `ContentService.importBundle` and `AuditService.record`, so publication cannot succeed without its audit record.

- [ ] **Step 4: Add negative tests for teacher access, invalid references, and version regression**

Expected responses:

- teacher import attempt: 403 with `{ code: "FORBIDDEN" }`.
- unknown knowledge reference: 422 with issue path and canonical ID.
- bundle version lower than latest: 409 with `{ code: "CONTENT_VERSION_REGRESSION" }`.

- [ ] **Step 5: Run API tests and verify audit immutability**

Run: `pnpm --filter @math/api test -- operator-content-api.test.ts`

Expected: all operator content tests pass.

Run a database test that attempts `UPDATE audit_events`; the application repository must expose no update/delete method, and database permissions used by the application must reject mutation in non-test environments.

- [ ] **Step 6: Commit operator content and audit routes**

```bash
git add apps/api/src/modules/audit apps/api/src/modules/content/routes.ts apps/api/src/app.ts apps/api/test/operator-content-api.test.ts
git commit -m "feat: expose audited operator content import"
```

### Task 7: Foundation Vertical-Slice Acceptance

**Files:**
- Create: `apps/api/test/foundation.e2e.test.ts`
- Create: `docs/development/foundation.md`
- Modify: `.env.example`
- Modify: `package.json`

**Interfaces:**
- Consumes every interface produced by Tasks 1–6.
- Produces root scripts: `dev:deps`, `db:migrate`, `seed:mock`, `test:foundation`, and `verify`.
- Produces a documented, repeatable local setup with no undocumented environment variables.

- [ ] **Step 1: Write the failing end-to-end scenario**

```ts
it("completes the foundation content and authorization slice", async () => {
  await operator.importBundle(mockBundle);
  const student = await guardian.createStudent({ displayName: "试用学生", grade: 7, semester: 1 });
  const classroom = await teacher.createClass({ name: "七年级试用班", subject: "math" });
  const membership = await teacher.inviteStudent(classroom.id, student.id);

  expect(await teacher.readStudentSummary(student.id)).toMatchObject({ status: 403 });

  await guardian.approveMembership(membership.id);

  expect(await teacher.readStudentSummary(student.id)).toMatchObject({ status: 200 });
  expect(await unrelatedTeacher.readStudentSummary(student.id)).toMatchObject({ status: 403 });
  expect(await operator.listPublishedQuestions()).toHaveLength(mockBundle.questions.length);
  expect(await audit.actions()).toEqual(expect.arrayContaining([
    "content.bundle.imported",
    "student.created",
    "class.created",
    "class.membership.requested",
    "class.membership.approved"
  ]));
});
```

- [ ] **Step 2: Run the scenario and verify any missing integration fails**

Run: `pnpm test:foundation`

Expected before final wiring: FAIL at the first unregistered route or missing audit event. Fix only the missing wiring identified by the failure.

- [ ] **Step 3: Add root verification scripts and local setup documentation**

Root scripts must execute:

```json
{
  "scripts": {
    "dev:deps": "docker compose -f infra/compose.yaml up -d postgres",
    "db:migrate": "pnpm --filter @math/db migrate",
    "seed:mock": "pnpm --filter @math/api seed -- ../../seed/mock-content-grade-7-semester-1.json",
    "test:foundation": "pnpm --filter @math/api test -- foundation.e2e.test.ts",
    "verify": "pnpm typecheck && pnpm test"
  }
}
```

`docs/development/foundation.md` must state exact commands for dependency installation, database startup, migration, seeding, API startup, full verification, and shutdown. It must explain that development identity headers are test-only and forbidden in production.

- [ ] **Step 4: Run the complete verification suite**

Run: `pnpm verify`

Expected: all package typechecks and tests pass with zero failures.

Run: `pnpm test:foundation`

Expected: the operator/guardian/teacher vertical slice passes and unrelated access remains 403.

Run: `pnpm seed:mock` twice.

Expected: the first run creates content; the second run reports only unchanged records.

- [ ] **Step 5: Inspect the migration and repository diff**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only the files listed in Task 7 are uncommitted.

- [ ] **Step 6: Commit the verified foundation slice**

```bash
git add package.json .env.example apps/api/test/foundation.e2e.test.ts docs/development/foundation.md
git commit -m "test: verify foundation vertical slice"
```

## Completion Criteria

This plan is complete only when all of the following are true:

- `pnpm verify` exits 0.
- `pnpm test:foundation` passes.
- The seed bundle is idempotent and retains prior versions.
- The teacher cannot read student data before guardian approval.
- The approved teacher can read only the authorized scope.
- An unrelated guardian or teacher receives 403 without student-existence disclosure.
- Every content import and relationship transition has an audit event.
- Development identity cannot start in production mode.
- The repository is clean after the final commit.

## Requirements Deferred to Later Slice Plans

The following confirmed requirements are intentionally outside this foundation slice and may not be started while executing this plan: OCR and image upload, student personal libraries, review scheduling, question similarity, mastery and ranks, PDF generation, paper-result recognition, parent and teacher interfaces, feedback rewards, automated pilot analytics, and full four-week acceptance testing.
