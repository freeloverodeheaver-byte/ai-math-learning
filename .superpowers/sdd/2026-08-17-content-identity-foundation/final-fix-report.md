# Final fix report

Fix base: `c1ac11448f1fb95dadaa1c300854744f9619cb8c`

## Implementation

- Added forward journal migration `0005_versioned_content_relationships`: immutable version-keyed prerequisite and question-link tables, deterministic backfill of the only historically recoverable stable relationship snapshot to every existing version, exact-version publication checks, and a database trigger rejecting `content_entity_owners.bundle_id` changes.
- New imports write stable compatibility relationships and immutable version snapshots; change detection reads the latest version snapshot. Stable IDs, bundle replay hashing, and idempotency are unchanged.
- Added typed `CONTENT_PAYLOAD_MUTATION` and `CONTENT_OWNERSHIP_CONFLICT` HTTP 409 mappings.
- Added config invalid-input matrix and PostgreSQL URL-scheme validation, direct access-method anti-`any` assertions, and a pnpm-11-safe selective foundation command.

## Finding verdicts

- I1 fixed: each knowledge/question version owns its relationship snapshot; focused history assertions cover v1/v2 divergence. Legacy data is copied without loss to all historical versions because the old schema retained no finer attribution.
- I2 fixed: both knowledge and question owner bundle moves are rejected at the database boundary.
- M1 fixed: deterministic mutation and ownership conflicts are sanitized typed 409 responses.
- M2 fixed: invalid environment, port boundaries/integer, strict boolean, malformed URL, and wrong scheme are covered.
- M3 fixed: assertions inspect `select`, `insert`, and `update` boundary types directly instead of inferring schema from a `Pick`.
- M4 fixed: `test:foundation` uses package-local `exec vitest run` and ran only the requested file.
- M5 partially hardened/deferred: no dependency/network changes were allowed and `TEST_DATABASE_URL` was unavailable. Native migration/access/content concurrency remain an explicit release gate; no native PostgreSQL success is claimed.
- M6 deferred on safety grounds: the current read route has no transactional audit host. Adding best-effort telemetry would violate the specification's audit guarantee; making audit failure fail closed preserves indistinguishable 403 but requires composition/API changes beyond the mandatory schema fix. Ruling: a future privacy-safe denial event must contain actor ID, requested scope, and a non-reversible keyed target digest (never target existence); audit failure must fail the request closed with the same 403 body. This remains an explicit release concern.

## TDD and verification evidence

- RED/root-cause evidence: review reproductions at the fix base demonstrated published v1 changing from `ka` to `kb`, and direct owner `bundle_id` update committing. The first focused post-change run also caught five compatibility expectations and three migration-integrity regressions; they were resolved without weakening service snapshot semantics.
- GREEN: `pnpm --filter @math/api test -- content-import.test.ts` -> 12 files, 130 tests passed (pnpm 10 forwards the legacy separator; full API execution documented).
- GREEN: `pnpm verify` -> contracts 15/15, db 29/29, API 130/130; typecheck clean.
- GREEN: `pnpm build` -> all three workspace packages built.
- GREEN: `pnpm test:foundation` -> exactly 1 file, 1 test passed.
- `git diff --check` clean; status inspected before commit.

## Files changed

Database schema/migration/journal and migration tests; content repository/service/routes and import/upgrade tests; config/health tests; access type guard; root script; this report.

## Concerns

- Native PostgreSQL migration/locking/concurrency requires a disposable fresh database and `TEST_DATABASE_URL` before release.
- Privacy-safe denied-read auditing remains open under the fail-closed semantics above.
