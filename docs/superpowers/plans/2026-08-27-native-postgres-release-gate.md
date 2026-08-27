# Native PostgreSQL Release Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the foundation release gate reproducible against a disposable real PostgreSQL 16 instance and prove migration, seed idempotency, content immutability, and concurrency behavior before the next product slice.

**Architecture:** Keep `TEST_DATABASE_URL` as the canonical external-database contract. Add a cross-platform development wrapper that uses that URL when supplied or starts an ephemeral PostgreSQL 16 cluster with `embedded-postgres` when Docker/local PostgreSQL is unavailable. Native assertions remain standalone Node programs so they exercise the built JavaScript, committed migrations, `pg`, Drizzle repositories, and real PostgreSQL locks/triggers rather than PGlite.

**Tech Stack:** Node.js 24, TypeScript, pnpm workspaces, PostgreSQL 16, `pg`, Drizzle ORM, `embedded-postgres@16.14.0-beta.17`, Node assertions.

**Spec:** `docs/superpowers/specs/2026-08-17-ai-math-learning-product-design.md`

## Global Constraints

- The product covers junior-middle-school mathematics for grades 7–9 only.
- The canonical release database is native PostgreSQL; PGlite results cannot satisfy this gate.
- The gate must never use `DATABASE_URL` and must reject or avoid databases that are not explicitly disposable.
- An existing `TEST_DATABASE_URL` remains supported for Docker, CI, or a developer-managed disposable database.
- The embedded fallback must use PostgreSQL 16, a random available loopback port, a temporary directory, non-persistent storage, and guaranteed shutdown in `finally`.
- No generated database files, credentials, or test data may be committed.
- Every native assertion must fail with a non-zero exit code and a specific assertion when the protected behavior regresses.
- Existing deterministic suites remain mandatory and unchanged: `pnpm verify` and `pnpm test:foundation`.
- Research basis: `embedded-postgres` supports Windows x64 and PostgreSQL 16 and requires its install script; Testcontainers is not a fallback because it still requires a container runtime.

---

### Task 1: Disposable Native PostgreSQL Gate Runner

**Files:**
- Modify: `package.json`
- Modify: `packages/db/package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Create: `packages/db/test/run-native-release-gates.ts`
- Modify: `docs/development/foundation.md`

**Interfaces:**
- Produces root command `pnpm test:native-release`.
- Produces `runNativeReleaseGates(options?: NativeGateOptions): Promise<void>` for direct script execution and focused orchestration tests.
- Consumes existing package scripts `@math/db test:native-migration` and `@math/api test:native-access-concurrency`.
- Exports no runtime application API.

- [ ] **Step 1: Add the pinned embedded PostgreSQL dependency and approved build entry**

Run:

```powershell
pnpm --filter @math/db add -D embedded-postgres@16.14.0-beta.17
```

Update `pnpm-workspace.yaml` so pnpm allows only the package install script required by the pinned embedded PostgreSQL dependency, alongside the existing esbuild allowance. Do not use a wildcard approval.

- [ ] **Step 2: Write the native gate runner**

Create `packages/db/test/run-native-release-gates.ts` with these behaviors:

```ts
export interface NativeGateOptions {
  readonly externalUrl?: string;
  readonly runCommand?: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<void>;
}

export async function runNativeReleaseGates(options: NativeGateOptions = {}): Promise<void>;
```

The runner must:

1. Prefer `options.externalUrl`, then `process.env.TEST_DATABASE_URL`.
2. Reject any selected URL whose pathname is empty, `/`, `/postgres`, or whose database name does not end in `_test`.
3. If no URL is supplied, reserve a random loopback port, create a temporary directory with `mkdtemp`, start non-persistent `embedded-postgres` 16 on `127.0.0.1`, and create `math_learning_test`.
4. Build `@math/db` and `@math/api` once.
5. Execute, in order, the native migration smoke test, the native content-integrity test added in Task 2, and the native access-concurrency test, passing only `TEST_DATABASE_URL` through the child environment.
6. Stop the embedded server and remove its exact temporary directory in `finally`; never remove a caller-supplied directory.
7. Preserve the first gate failure while still attempting cleanup.

Use `spawn` with argument arrays and `shell: false`; do not construct shell command strings containing credentials.

- [ ] **Step 3: Expose the command and document both database paths**

Add:

```json
{
  "scripts": {
    "test:native-release": "pnpm --filter @math/db exec tsx test/run-native-release-gates.ts"
  }
}
```

Document:

```powershell
pnpm test:native-release
```

as the zero-configuration local fallback, and retain:

```powershell
$env:TEST_DATABASE_URL = "postgresql://math_app:math_app@127.0.0.1:5432/math_learning_test"
pnpm test:native-release
```

for an explicitly disposable external database. State that the gate refuses database names without the `_test` suffix.

- [ ] **Step 4: Run the runner through its first expected failure**

Run:

```powershell
pnpm test:native-release
```

Expected: PostgreSQL starts and migration smoke passes, then the command fails because `dist/test/native-content-integrity.js` does not exist. This is the RED proof that the orchestration reaches the missing Task 2 gate.

- [ ] **Step 5: Commit the runner slice**

```powershell
git add package.json packages/db/package.json pnpm-workspace.yaml pnpm-lock.yaml packages/db/test/run-native-release-gates.ts docs/development/foundation.md
git commit -m "test(db): add disposable PostgreSQL release runner"
```

---

### Task 2: Native Content Integrity and Concurrency Gate

**Files:**
- Modify: `apps/api/package.json`
- Create: `apps/api/test/native-content-integrity.ts`
- Modify: `docs/development/foundation.md`

**Interfaces:**
- Produces package command `@math/api test:native-content-integrity`.
- Consumes `TEST_DATABASE_URL`, built database exports, committed migrations, `ContentService`, `ContentRepository`, `AuditService`, and the mock grade-7 semester-1 bundle.
- Produces no runtime application API.

- [ ] **Step 1: Write the native assertion program**

Create `apps/api/test/native-content-integrity.ts` as a standalone assertion program. It must use two independent database pools and real services/repositories. Each case must use unique bundle and content identifiers so it can run after the migration smoke test without resetting the database.

The program must assert:

1. `migrateDb` succeeds when replayed on the already migrated native database.
2. Importing and publishing the same bundle twice leaves one stable content record and one published version per item; the second result reports every item as unchanged while import and publication audit events are appended for both invocations.
3. Two simultaneous imports of the same new bundle version serialize: exactly one creates/publishes the version, the other reports unchanged, and no duplicate stable entities, versions, relationships, or bundle-version rows exist.
4. Direct INSERT, UPDATE, DELETE, owner reassignment, and delete-and-replace attempts against published question relationships and published knowledge prerequisites are rejected.
5. The same relationship mutation matrix is rejected after retirement.
6. Direct deletion of published/retired versions and deletion through stable-owner cascades is rejected, while an editable draft version remains deletable.
7. Published content may transition only to retired, and retired content cannot return to any editable or published state.
8. Every assertion failure names the violated invariant and the relevant content identifier.

Derive all expected counts as literal values from the fixture. Do not reuse the code under test to calculate expectations, and do not mock PostgreSQL, repositories, transactions, or locks.

- [ ] **Step 2: Add the package command and connect it to the runner**

Add:

```json
{
  "scripts": {
    "test:native-content-integrity": "node dist/test/native-content-integrity.js"
  }
}
```

The Task 1 runner invokes this command between native migration and native access concurrency.

- [ ] **Step 3: Run the content gate and confirm GREEN**

Run:

```powershell
pnpm test:native-release
```

Expected: exit 0 after the migration, content-integrity, and access-concurrency gates complete against one disposable PostgreSQL 16 database.

- [ ] **Step 4: Run deterministic regression and build gates**

Run:

```powershell
pnpm verify
pnpm test:foundation
pnpm build
git diff --check
```

Expected: all commands exit 0 with no failures or whitespace errors.

- [ ] **Step 5: Commit the native content gate**

```powershell
git add apps/api/package.json apps/api/test/native-content-integrity.ts docs/development/foundation.md
git commit -m "test(db): verify native content integrity"
```

## Completion Criteria

- `pnpm test:native-release` starts or connects to real PostgreSQL 16 and exits 0.
- The gate covers fresh/replayed migrations, seed-equivalent idempotent publication, concurrent import serialization, immutable published/retired relationship snapshots, locked-version cascade protection, and existing access races.
- `pnpm verify`, `pnpm test:foundation`, and `pnpm build` exit 0.
- The branch contains only intentional source, manifest, lockfile, and documentation changes; no database data directory is tracked.
