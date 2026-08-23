# Task 6 Report: Audit Service and Operator Content API

## Implementation summary

- Added operator-only bundle validation and import routes.
- Validation uses `ContentBundleSchema.safeParse`, returns actionable Zod issues, and has no persistence dependencies or side effects.
- Import parses before opening a transaction, returns a typed `CONTENT_VERSION_REGRESSION` conflict, and sanitizes unexpected failures.
- Import, exact-revision publication, and both `content.bundle.imported` / `content.bundle.published` audit appends share exactly one outer transaction.
- Replays of an identical bundle revision remain idempotent for content/tracking/version/publication state while appending two audit events for each request.
- Added an append-only `AuditRepository`/`AuditService` boundary and a forward `0004` database trigger rejecting audit `UPDATE` and `DELETE`.
- Added one database-backed composition function used by the real `main.ts`; `main.ts` still creates/owns the pool and retains its `onClose` cleanup.
- Replaced the content transaction boundary's `PgDatabase<any, any, any>` with a zero-`any`, driver-neutral structural Drizzle query type compatible with Node `pg` and PGlite.

## TDD evidence

Command used for focused API cycles:

```text
pnpm --filter @math/api test -- operator-content-api.test.ts
```

Observed RED evidence:

1. Initial validation route: `expected 404 to be 200`; 1 failed and 89 baseline tests passed.
2. Structured validation: `expected 500 to be 422`; 1 failed and 92 tests passed.
3. Import role boundary: missing route returned 404 instead of 401; after registration, the teacher response exposed Fastify's default wrapper instead of exact `{ code: "FORBIDDEN" }`.
4. Successful import: after adding the test-declared audit modules, the route returned 503 instead of 201. A subsequent unexpected 500 was traced systematically to the Fastify plugin callback not accepting its `options` parameter (`ReferenceError: options is not defined`).
5. Version regression: a lower revision returned 500 instead of typed 409; 1 failed and 95 tests passed.
6. Database append-only boundary:

```text
pnpm --filter @math/db test -- schema.integration.test.ts migration-packaging.test.ts
```

Both source and built-journal tests observed `UPDATE audit_events` resolve with `affectedRows: 1`; 2 failed and 27 passed before migration `0004`.

7. Production composition: the test initially failed because `composition.js` did not exist; 89 baseline tests passed.

Observed focused GREEN evidence:

- Latest operator API run: 7 files passed, 103 tests passed.
- Database migration source/build run: 2 files passed, 29 tests passed.
- The focused API suite covers validation no-write, 401/403 gates, structured 422, typed 409, successful publish plus two actor audits, exact-revision isolation, idempotent auditable replay, second-audit failure rollback, publication failure rollback, real composition, and outer transaction identity.

## Final verification

- `pnpm test` — exit 0:
  - contracts: 1 file, 10 tests passed
  - database: 2 files, 29 tests passed
  - API: 7 files, 103 tests passed
  - total: 10 files, 142 tests passed
- `pnpm typecheck` — exit 0 for contracts, database, and API.
- `pnpm build` — exit 0 for contracts, database (including migration copy), and API.
- `git diff --check` — exit 0.
- `TEST_DATABASE_URL` was unset. Native PostgreSQL tests were not run or claimed; they remain a release gate.

## Files changed

- `apps/api/src/app.ts`
- `apps/api/src/composition.ts`
- `apps/api/src/main.ts`
- `apps/api/src/modules/audit/repository.ts`
- `apps/api/src/modules/audit/service.ts`
- `apps/api/src/modules/content/repository.ts`
- `apps/api/src/modules/content/routes.ts`
- `apps/api/src/modules/content/service.ts`
- `apps/api/test/operator-content-api.test.ts`
- `packages/db/migrations/0004_audit_events_append_only.sql`
- `packages/db/migrations/meta/_journal.json`
- `packages/db/test/migration-packaging.test.ts`
- `packages/db/test/schema.integration.test.ts`
- `.superpowers/sdd/2026-08-17-content-identity-foundation/task-6-report.md`

## Self-review

- Authorization is evaluated before body validation or dependency availability on both routes.
- Import validates before transaction/persistence; the no-write test checks bundle, stable content, and audit rows.
- Publication filters by bundle ownership and exact version; a foreign bundle's same-numbered revision stays draft.
- The identity test observes one outer callback and the same transaction object at content import, publication, and both audit appends.
- The audit rollback test fails the second append, proving the first audit plus all import/publication changes roll back together.
- Idempotency assertions cover bundle tracking, knowledge versions, question versions, publication response, and four audit events across two requests.
- The audit repository exposes only `append`; database tests reject both update and delete from source and built journals.
- Unexpected route failures return only `{ code: "INTERNAL_ERROR" }`, without raw database details.
- Mutation review: removing role gates, validation, bundle/version scoping, either audit append, rollback participation, or the append-only trigger is covered by a focused assertion.

## Concerns and release gates

- Native PostgreSQL behavior remains unverified locally because `TEST_DATABASE_URL` is unavailable. PGlite covers the contract, but native PostgreSQL remains the release gate required by earlier tasks and this task.
- The pre-existing access-layer alias `AccessTransaction = PgDatabase<any, any, any>` is intentionally untouched and remains a named Task 7 concern. Task 6's content and audit transaction boundaries are zero-`any`.
- Migration `0004` enforces the approved stronger append-only invariant for every database user. Future retention or repair tooling will need an explicitly privileged maintenance path rather than ordinary application DML.
