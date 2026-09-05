import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflowPath = new URL("../../.github/workflows/release-gate.yml", import.meta.url);
function readWorkflow() { return parse(readFileSync(workflowPath, "utf8")); }

test("release gate uses the approved triggers and PR-only cancellation", () => {
  const workflow = readWorkflow();
  assert.deepEqual(Object.keys(workflow).sort(), ["concurrency", "jobs", "name", "on", "permissions"]);
  assert.equal(workflow.name, "Release Gate");
  assert.deepEqual(workflow.on, { pull_request: { branches: ["master"] }, push: { branches: ["master"] }, workflow_dispatch: {}, merge_group: { types: ["checks_requested"] } });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, { group: "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.run_id }}", "cancel-in-progress": "${{ github.event_name == 'pull_request' }}" });
});

test("platform matrix runs the approved immutable toolchain and gates", () => {
  const job = readWorkflow().jobs["platform-gates"];
  assert.deepEqual(job, {
    name: "Platform gates (${{ matrix.os }})", "runs-on": "${{ matrix.os }}", "timeout-minutes": 30,
    strategy: { "fail-fast": false, matrix: { os: ["ubuntu-24.04", "windows-2025"] } },
    steps: [
      { name: "Checkout", uses: "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd", with: { "persist-credentials": false } },
      { name: "Set up pnpm", uses: "pnpm/action-setup@0e279bb959325dab635dd2c09392533439d90093", with: { version: "10.34.5", run_install: false } },
      { name: "Set up Node.js", uses: "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38", with: { "node-version": "24.20.0", cache: "pnpm", "cache-dependency-path": "pnpm-lock.yaml" } },
      { name: "Install frozen dependencies", run: "pnpm install --frozen-lockfile" },
      { name: "Validate CI configuration", run: "pnpm test:ci-config" },
      { name: "Verify repository", run: "pnpm verify" },
      { name: "Run foundation gate", run: "pnpm test:foundation" },
      { name: "Build packages", run: "pnpm build" },
      { name: "Run native PostgreSQL release gate", run: "pnpm test:native-release" },
    ],
  });
});

test("fixed aggregator fails unless the complete matrix succeeds", () => {
  const job = readWorkflow().jobs["release-gate"];
  assert.deepEqual(Object.keys(job).sort(), ["if", "name", "needs", "runs-on", "steps", "timeout-minutes"]);
  assert.equal(job.name, "Release Gate Required"); assert.equal(job.needs, "platform-gates"); assert.equal(job.if, "${{ always() }}");
  assert.equal(job["runs-on"], "ubuntu-24.04"); assert.equal(job["timeout-minutes"], 5); assert.equal(job.steps.length, 1);
  assert.deepEqual(Object.keys(job.steps[0]).sort(), ["name", "run", "shell"]);
  assert.equal(job.steps[0].name, "Require every platform gate to succeed"); assert.equal(job.steps[0].shell, "bash");
  assert.equal(job.steps[0].run.trim(), ['if [ "${{ needs.platform-gates.result }}" != "success" ]; then', '  echo "Platform gate result: ${{ needs.platform-gates.result }}"', "  exit 1", "fi"].join("\n"));
});

test("workflow has no secret, deployment, service-container, or artifact path", () => {
  const source = readFileSync(workflowPath, "utf8"); const workflow = readWorkflow();
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ["platform-gates", "release-gate"]);
  assert.doesNotMatch(source, /\bsecrets\b/i); assert.doesNotMatch(source, /TEST_DATABASE_URL|DATABASE_URL/); assert.doesNotMatch(source, /upload-artifact|download-artifact/i);
});
