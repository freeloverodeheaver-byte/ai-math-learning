# Foundation development workflow

## Prerequisites

Use Node.js 24.x or newer and pnpm 10.34.5 (the version pinned by the root `packageManager` field). Node 24 is the minimum supported runtime for this workflow because the package entry scripts use the native `--env-file-if-exists` flag. Docker with Compose is required for the canonical local PostgreSQL runtime. From the repository root, install the already-declared dependencies:

```sh
node --version
pnpm --version
pnpm install
```

This foundation covers grades 7–9 mathematics only.

## Configure and start PostgreSQL

Copy the environment template to the repository root, then edit that root `.env` if the default local port or database credentials conflict with your machine:

```sh
cp .env.example .env
pnpm dev:deps
docker compose -f infra/compose.yaml ps postgres
docker compose -f infra/compose.yaml exec postgres pg_isready -U math_app -d math_learning
```

Apply the committed migration journal:

```sh
pnpm db:migrate
```

The database migration and API development/start/seed package scripts run from their package directories and automatically load `../../.env`, which resolves to the repository-root `.env`. Values already supplied by the shell or deployment environment take precedence over file values. `DATABASE_URL` is used by migration, seed, and API runtime commands. `TEST_DATABASE_URL` is optional and is reserved for the disposable native PostgreSQL release gates below; never point it at a database containing data you need to keep.

## Audited published seed

The development seed uses the same validation and atomic import → publish → audit workflow as the operator HTTP API:

```sh
pnpm seed:mock
pnpm seed:mock
```

On a freshly migrated database the first result is:

```json
{"createdKnowledge":3,"createdQuestions":2,"newVersions":0,"unchanged":0}
```

The immediate replay is content/version/publication-idempotent and reports:

```json
{"createdKnowledge":0,"createdQuestions":0,"newVersions":0,"unchanged":5}
```

Both invocations append `content.bundle.imported` and `content.bundle.published` audit events. System seed events use a null actor and include `initiator: "system_seed"`. Mock and formal content must satisfy the same strict bundle contract, provenance rules, and import workflow; AI-generated material is not publishable through this foundation path.

## Run and verify the API

Start the development server:

```sh
pnpm --filter @math/api dev
```

Run the repository and focused foundation gates:

```sh
pnpm verify
pnpm test:foundation
```

`x-dev-user-id` and `x-dev-roles` are development/test-only identity headers. `DEV_IDENTITY_ENABLED=true` is rejected when `NODE_ENV=production`; production identity must use a real provider rather than these headers.

## Optional native PostgreSQL release gates

When a separate disposable PostgreSQL database is available, set `TEST_DATABASE_URL` and run the native migration and concurrency gates. In PowerShell, for example:

```powershell
$env:TEST_DATABASE_URL = "postgresql://math_app:math_app@127.0.0.1:5432/math_learning_test"
pnpm --filter @math/db build
pnpm --filter @math/db test:native-migration
pnpm --filter @math/api test:native-access-concurrency
```

These gates are intentionally separate from the deterministic PGlite suites. They are required before a native PostgreSQL release but should be skipped—not simulated—when Docker or `TEST_DATABASE_URL` is unavailable.

## Safe shutdown

Stop the local services without deleting the named database volume:

```sh
docker compose -f infra/compose.yaml down
```

Do not add `--volumes` unless deleting the persisted local PostgreSQL data is explicitly intended.
