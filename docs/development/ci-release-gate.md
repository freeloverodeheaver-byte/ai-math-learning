# CI release gate

The `Release Gate` GitHub Actions workflow qualifies changes; it does not deploy software or connect to production. It runs the same frozen dependency installation and project gates on `ubuntu-24.04` and `windows-2025`. `Release Gate Required` succeeds only when both platform jobs succeed.

## Activate the required check

The workflow is active in the public
[`freeloverodeheaver-byte/ai-math-learning`](https://github.com/freeloverodeheaver-byte/ai-math-learning)
repository. Its default branch is `master`. GitHub repository administrators should
use the following activation sequence:

1. Let the workflow complete successfully once on `master`.
2. In the branch protection rule or repository Ruleset for `master`, require the status check named exactly `Release Gate Required`. When GitHub offers source selection, select **GitHub Actions** as its expected source. This display name is reserved and must remain unique across every workflow in the repository.
3. Open a test pull request and verify that a failing or pending gate blocks merging and that a successful gate permits merging.

Do not require the two matrix display names separately. The fixed aggregator is the supported branch-protection interface.

The initial hosted activation, its cross-shell repair, and the status of the
Ruleset and merge-blocking acceptance checks are recorded in
[GitHub release gate acceptance](github-release-gate-acceptance.md). That record,
rather than a local run, is the source of truth for whether activation is complete.

## Diagnose a failure

Open the failed `Release Gate` run and inspect the first failing step in `Platform gates (ubuntu-24.04)` or `Platform gates (windows-2025)`:

- `Install frozen dependencies`: verify `package.json` and `pnpm-lock.yaml` were committed together and reproduce with `corepack pnpm install --frozen-lockfile`.
- `Validate CI configuration`: run `corepack pnpm test:ci-config`; restore the exact triggers, permissions, pins, matrix, command order, and aggregator semantics defined by the contract.
- `Verify repository`: run `corepack pnpm verify`.
- `Run foundation gate`: run `corepack pnpm test:foundation`.
- `Build packages`: run `corepack pnpm build`.
- `Run native PostgreSQL release gate`: run `corepack pnpm test:native-release`; do not point `TEST_DATABASE_URL` at retained data.
- `Release Gate Required`: inspect both platform jobs. This job intentionally fails when the matrix result is failed, cancelled, or timed out.

The native release runner starts a disposable embedded PostgreSQL 16 instance when `TEST_DATABASE_URL` is absent and removes it in cleanup. CI must not receive production database variables.

## Rerun and reproduce

Use GitHub Actions **Re-run failed jobs** after identifying a transient hosted-runner failure. For code, dependency, build, or database failures, reproduce the exact failing command locally, fix the cause, and push a new commit. A manual qualification run can be started through `workflow_dispatch`; pull request runs alone share a concurrency group and cancel older runs for the same change. Push, manual, and merge-group runs use their unique run IDs so pending runs are not replaced.

Run the complete local sequence from the repository root:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm test:ci-config
corepack pnpm verify
corepack pnpm test:foundation
corepack pnpm build
corepack pnpm test:native-release
```

Local success proves the current machine's path only. The required GitHub result remains the dual-platform `Release Gate Required` check.

## Safely retire or rename the gate

1. First remove `Release Gate Required` from the `master` branch protection rule or Ruleset.
2. Confirm pull requests are not waiting for that required check.
3. Only then delete the workflow or rename its workflow, job, or required-check display name.

Deleting or renaming the workflow first can leave pull requests permanently waiting for a required status that can no longer be produced.
