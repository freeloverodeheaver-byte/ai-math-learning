# CI/CD Dual-Platform Release Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only GitHub Actions qualification gate that requires the existing release checks to pass on Ubuntu 24.04 and Windows Server 2025 before a change is eligible to merge.

**Architecture:** A single matrix job runs an identical frozen-install and verification sequence on both native runners. A fixed-name aggregator job executes unconditionally and succeeds only when the complete matrix succeeds, giving branch protection one stable required-check name. A Node test parses the workflow YAML and enforces the security, platform, trigger, command-order, and aggregation contract.

**Tech Stack:** GitHub Actions YAML, Node.js 24.20.0, pnpm 10.34.5, Node built-in test runner, `yaml` 2.8.1, embedded PostgreSQL 16 release runner

**Spec:** `docs/superpowers/specs/2026-09-03-ci-release-gate-design.md`

## Global Constraints

- Work only in the existing isolated worktree `C:\Users\Administrator\Desktop\project1\.worktrees\ci-release-gate` on branch `codex/ci-release-gate`.
- The approved spec and this implementation plan are committed before execution begins; implementation tasks must preserve a clean boundary from those documentation commits.
- The workflow is a qualification gate only: no production connection, deployment, Docker image, GitHub write permission, or secret use.
- Matrix runners are exactly `ubuntu-24.04` and `windows-2025`; matrix `fail-fast` is false.
- Node.js is exactly `24.20.0`; pnpm is exactly `10.34.5`; dependency installation uses `pnpm install --frozen-lockfile`.
- The platform command order is `pnpm test:ci-config`, `pnpm verify`, `pnpm test:foundation`, `pnpm build`, `pnpm test:native-release`.
- Workflow permission is exactly `contents: read`; checkout credentials are not persisted.
- Action references are full reviewed commit SHAs: checkout `de0fac2e4500dabe0009e67214ff5f5447ce83dd`, pnpm setup `0e279bb959325dab635dd2c09392533439d90093`, Node setup `249970729cb0ef3589644e2896645e5dc5ba9c38`.
- The only required-check name documented for branch protection is `Release Gate Required`.
- Do not add artifacts, service containers, `pull_request_target`, branch-protection automation, or production database variables.
- Preserve the main worktree's unrelated untracked `.pnpm-store/` directory; never stage it.
- Every implementation task receives a fresh implementation subagent, then a specification-compliance review and a code-quality review before proceeding.

## File Structure

- Create `.github/workflows/release-gate.yml`: the complete dual-platform GitHub Actions workflow and fixed aggregator job.
- Create `scripts/ci/release-gate.contract.test.mjs`: semantic workflow contract tests using Node's test runner and a YAML parser.
- Modify `package.json`: add exact `yaml` development dependency and the `test:ci-config` script.
- Modify `pnpm-lock.yaml`: lock the new exact root development dependency.
- Create `docs/development/ci-release-gate.md`: activation, diagnosis, rerun, local reproduction, and safe retirement runbook.
- Modify `docs/development/foundation.md`: connect the existing native PostgreSQL release instructions to the new CI runbook.

## Execution Preconditions

Before dispatching the first implementation subagent, run:

```powershell
git log -2 --oneline
git status --porcelain
```

Expected: the log includes the approved design and implementation-plan documentation commits, and `git status --porcelain` prints nothing. If the plan document is still untracked or modified, commit only the plan/spec documentation before implementation begins.

---

### Task 1: Workflow Contract and Dual-Platform Gate

**Files:**
- Create: `.github/workflows/release-gate.yml`
- Create: `scripts/ci/release-gate.contract.test.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: root `packageManager` value `pnpm@10.34.5` and existing scripts `verify`, `test:foundation`, `build`, and `test:native-release`.
- Produces: root command `pnpm test:ci-config`; GitHub status check `Release Gate Required`; workflow jobs `platform-gates` and `release-gate`.

- [ ] **Step 1: Add the exact YAML parser development dependency and test command**

Run from the isolated worktree root:

```powershell
corepack pnpm add --save-dev --save-exact --workspace-root yaml@2.8.1
```

Then add this entry to the root `scripts` object in `package.json`:

```json
"test:ci-config": "node --test scripts/ci/release-gate.contract.test.mjs"
```

Expected: `package.json` contains `"yaml": "2.8.1"` in root `devDependencies`, and `pnpm-lock.yaml` records the exact dependency.

- [ ] **Step 2: Write the semantic contract test before the workflow exists**

Create `scripts/ci/release-gate.contract.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflowPath = new URL("../../.github/workflows/release-gate.yml", import.meta.url);

function readWorkflow() {
  return parse(readFileSync(workflowPath, "utf8"));
}

test("release gate uses the approved triggers and PR-only cancellation", () => {
  const workflow = readWorkflow();

  assert.deepEqual(Object.keys(workflow).sort(), [
    "concurrency",
    "jobs",
    "name",
    "on",
    "permissions",
  ]);
  assert.equal(workflow.name, "Release Gate");
  assert.deepEqual(workflow.on, {
    pull_request: { branches: ["master"] },
    push: { branches: ["master"] },
    workflow_dispatch: {},
    merge_group: { types: ["checks_requested"] },
  });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, {
    group:
      "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.run_id }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
  });
});

test("platform matrix runs the approved immutable toolchain and gates", () => {
  const workflow = readWorkflow();
  const job = workflow.jobs["platform-gates"];

  assert.deepEqual(job, {
    name: "Platform gates (${{ matrix.os }})",
    "runs-on": "${{ matrix.os }}",
    "timeout-minutes": 30,
    strategy: {
      "fail-fast": false,
      matrix: { os: ["ubuntu-24.04", "windows-2025"] },
    },
    steps: [
      {
        name: "Checkout",
        uses: "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
        with: { "persist-credentials": false },
      },
      {
        name: "Set up pnpm",
        uses: "pnpm/action-setup@0e279bb959325dab635dd2c09392533439d90093",
        with: { version: "10.34.5", run_install: false },
      },
      {
        name: "Set up Node.js",
        uses: "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
        with: {
          "node-version": "24.20.0",
          cache: "pnpm",
          "cache-dependency-path": "pnpm-lock.yaml",
        },
      },
      { name: "Install frozen dependencies", run: "pnpm install --frozen-lockfile" },
      { name: "Validate CI configuration", run: "pnpm test:ci-config" },
      { name: "Verify repository", run: "pnpm verify" },
      { name: "Run foundation gate", run: "pnpm test:foundation" },
      { name: "Build packages", run: "pnpm build" },
      {
        name: "Run native PostgreSQL release gate",
        run: "pnpm test:native-release",
      },
    ],
  });
});

test("fixed aggregator fails unless the complete matrix succeeds", () => {
  const workflow = readWorkflow();
  const job = workflow.jobs["release-gate"];

  assert.deepEqual(Object.keys(job).sort(), [
    "if",
    "name",
    "needs",
    "runs-on",
    "steps",
    "timeout-minutes",
  ]);
  assert.equal(job.name, "Release Gate Required");
  assert.equal(job.needs, "platform-gates");
  assert.equal(job.if, "${{ always() }}");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job["timeout-minutes"], 5);
  assert.equal(job.steps.length, 1);
  assert.deepEqual(Object.keys(job.steps[0]).sort(), ["name", "run", "shell"]);
  assert.equal(job.steps[0].name, "Require every platform gate to succeed");
  assert.equal(job.steps[0].shell, "bash");
  assert.equal(
    job.steps[0].run.trim(),
    [
      'if [ "${{ needs.platform-gates.result }}" != "success" ]; then',
      '  echo "Platform gate result: ${{ needs.platform-gates.result }}"',
      "  exit 1",
      "fi",
    ].join("\n"),
  );
});

test("workflow has no secret, deployment, service-container, or artifact path", () => {
  const source = readFileSync(workflowPath, "utf8");
  const workflow = readWorkflow();

  assert.deepEqual(Object.keys(workflow.jobs).sort(), ["platform-gates", "release-gate"]);
  assert.doesNotMatch(source, /\bsecrets\b/i);
  assert.doesNotMatch(source, /TEST_DATABASE_URL|DATABASE_URL/);
  assert.doesNotMatch(source, /upload-artifact|download-artifact/i);
});
```

- [ ] **Step 3: Run the contract test and confirm the intended red state**

Run:

```powershell
corepack pnpm test:ci-config
```

Expected: FAIL with `ENOENT` for `.github/workflows/release-gate.yml`. A syntax error, missing dependency, or any other failure is not the intended red state and must be corrected before continuing.

- [ ] **Step 4: Create the minimal workflow that satisfies the contract**

Create `.github/workflows/release-gate.yml`:

```yaml
name: Release Gate

on:
  pull_request:
    branches: [master]
  push:
    branches: [master]
  workflow_dispatch: {}
  merge_group:
    types: [checks_requested]

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.run_id }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  platform-gates:
    name: Platform gates (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-24.04, windows-2025]
    steps:
      - name: Checkout
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false

      - name: Set up pnpm
        uses: pnpm/action-setup@0e279bb959325dab635dd2c09392533439d90093 # v6.0.8
        with:
          version: "10.34.5"
          run_install: false

      - name: Set up Node.js
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0
        with:
          node-version: "24.20.0"
          cache: pnpm
          cache-dependency-path: pnpm-lock.yaml

      - name: Install frozen dependencies
        run: pnpm install --frozen-lockfile

      - name: Validate CI configuration
        run: pnpm test:ci-config

      - name: Verify repository
        run: pnpm verify

      - name: Run foundation gate
        run: pnpm test:foundation

      - name: Build packages
        run: pnpm build

      - name: Run native PostgreSQL release gate
        run: pnpm test:native-release

  release-gate:
    name: Release Gate Required
    needs: platform-gates
    if: ${{ always() }}
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - name: Require every platform gate to succeed
        shell: bash
        run: |
          if [ "${{ needs.platform-gates.result }}" != "success" ]; then
            echo "Platform gate result: ${{ needs.platform-gates.result }}"
            exit 1
          fi
```

- [ ] **Step 5: Run the focused test and confirm the green state**

Run:

```powershell
corepack pnpm test:ci-config
```

Expected: 4 tests pass, 0 fail.

- [ ] **Step 6: Verify the frozen lockfile can install without mutation**

Run:

```powershell
git add package.json pnpm-lock.yaml
corepack pnpm install --frozen-lockfile
git diff --exit-code -- package.json pnpm-lock.yaml
```

Expected: install succeeds and the final command exits 0 because installation created no unstaged package or lockfile mutation beyond the already staged intended changes.

- [ ] **Step 7: Commit the workflow and its executable contract**

```powershell
git add .github/workflows/release-gate.yml scripts/ci/release-gate.contract.test.mjs package.json pnpm-lock.yaml
git commit -m "ci: add dual-platform release gate"
```

Expected: one commit containing only the four listed files.

---

### Task 2: Release Gate Operations Runbook

**Files:**
- Create: `docs/development/ci-release-gate.md`
- Modify: `docs/development/foundation.md`

**Interfaces:**
- Consumes: workflow name `Release Gate`, required-check name `Release Gate Required`, and root commands from Task 1.
- Produces: operator procedure for enabling, diagnosing, rerunning, reproducing, and safely retiring the gate.

- [ ] **Step 1: Create the runbook with exact operating procedures**

Create `docs/development/ci-release-gate.md` with these sections and commands:

```markdown
# CI release gate

The `Release Gate` GitHub Actions workflow qualifies changes; it does not deploy software or connect to production. It runs the same frozen dependency installation and project gates on `ubuntu-24.04` and `windows-2025`. `Release Gate Required` succeeds only when both platform jobs succeed.

## Activate the required check

The current local repository has no GitHub remote, so these steps require a future GitHub repository administrator:

1. Push the workflow to GitHub and let it complete successfully once on `master`.
2. In the branch protection rule or repository Ruleset for `master`, require the status check named exactly `Release Gate Required`.
3. Open a test pull request and verify that a failing or pending gate blocks merging and that a successful gate permits merging.

Do not require the two matrix display names separately. The fixed aggregator is the supported branch-protection interface.

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
```

- [ ] **Step 2: Link the runbook from the existing foundation workflow**

Append this paragraph to the end of the `Native PostgreSQL release gates` section in `docs/development/foundation.md`, immediately before `## Safe shutdown`:

```markdown
GitHub pull requests and `master` pushes run these gates on native Ubuntu and Windows runners. See [CI release gate](./ci-release-gate.md) for the required-check contract, failure diagnosis, local reproduction, and safe retirement procedure.
```

- [ ] **Step 3: Check documentation names and forbidden claims**

Run:

```powershell
rg -n "Release Gate Required|ubuntu-24.04|windows-2025|no GitHub remote|Safely retire" docs/development/ci-release-gate.md
rg -n "CI release gate" docs/development/foundation.md
rg -n "deployed|production deployment enabled|required check is active" docs/development/ci-release-gate.md
```

Expected: the first two commands find the documented contract and link; the third command returns no matches, so the documentation does not claim deployment or remote branch protection is active.

- [ ] **Step 4: Re-run the configuration contract after documentation changes**

Run:

```powershell
corepack pnpm test:ci-config
```

Expected: 4 tests pass, 0 fail.

- [ ] **Step 5: Commit the operations documentation**

```powershell
git add docs/development/ci-release-gate.md docs/development/foundation.md
git commit -m "docs: add release gate operations runbook"
```

Expected: one commit containing only the two documentation files.

---

### Task 3: Full Qualification and Independent Review

**Files:**
- Verify only: `.github/workflows/release-gate.yml`
- Verify only: `scripts/ci/release-gate.contract.test.mjs`
- Verify only: `package.json`
- Verify only: `pnpm-lock.yaml`
- Verify only: `docs/development/ci-release-gate.md`
- Verify only: `docs/development/foundation.md`

**Interfaces:**
- Consumes: all deliverables and commits from Tasks 1–2.
- Produces: evidence that the feature branch is clean, locally qualified, spec-compliant, and ready for the later merge decision.

- [ ] **Step 1: Run the exact frozen installation and focused CI contract**

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm test:ci-config
```

Expected: installation succeeds without lockfile mutation; 4 contract tests pass.

- [ ] **Step 2: Run all existing repository qualification commands**

Run each command separately so the failing boundary remains visible:

```powershell
corepack pnpm verify
corepack pnpm test:foundation
corepack pnpm build
corepack pnpm test:native-release
```

Expected: all commands exit 0. The native release command starts and cleans its disposable PostgreSQL 16 instance and passes migration, content-integrity, and access-concurrency gates.

- [ ] **Step 3: Run repository hygiene checks**

```powershell
git diff --check master...HEAD
git status --short --branch
git diff --name-only master...HEAD
```

Expected: no whitespace errors; status is clean on `codex/ci-release-gate`; changed files are limited to the design, plan, workflow, contract test, root package/lock files, and two development documents. `.pnpm-store/` is absent from the diff.

- [ ] **Step 4: Dispatch an independent specification-compliance reviewer**

Provide the reviewer with the spec path, plan path, `git diff master...HEAD`, and verification outputs. Require an explicit verdict for every acceptance criterion in spec section 11 and require findings to include file and line references.

Expected: reviewer returns `APPROVED` or concrete defects. If defects exist, return to the responsible implementation task, apply only verified corrections, rerun that task's checks, and request a fresh compliance review.

- [ ] **Step 5: Dispatch an independent code-quality and CI-security reviewer**

Ask a different reviewer to inspect YAML semantics, expression behavior, matrix failure propagation, permissions, immutable Action pins, caching, cross-platform shell compatibility, test brittleness, and runbook safety.

Expected: reviewer returns `APPROVED` or concrete defects with file and line references. Correct verified defects and rerun Steps 1–3 before requesting a fresh review.

- [ ] **Step 6: Record the final verification commit only if review corrections changed files**

If review corrections changed files:

```powershell
git add .github/workflows/release-gate.yml scripts/ci/release-gate.contract.test.mjs package.json pnpm-lock.yaml docs/development/ci-release-gate.md docs/development/foundation.md
git commit -m "fix: address release gate review findings"
```

If no files changed, do not create an empty commit.

- [ ] **Step 7: Hand off for branch integration without claiming remote activation**

Report the branch name, commit list, exact local verification results, independent review verdicts, and the documented limitation that no GitHub remote exists. Do not claim Ubuntu/Windows hosted runs or branch protection succeeded until the branch is pushed and those external checks actually complete.

Expected: the next user decision is whether to merge `codex/ci-release-gate` into `master`; remote activation remains a separate administrator step after a GitHub repository exists.
