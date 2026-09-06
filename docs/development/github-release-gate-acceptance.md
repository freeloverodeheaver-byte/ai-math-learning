# GitHub release gate acceptance

This document records the hosted activation and acceptance history for the
`Release Gate` workflow in the public
[`freeloverodeheaver-byte/ai-math-learning`](https://github.com/freeloverodeheaver-byte/ai-math-learning)
repository. The gate qualifies source changes only. It does not deploy software,
connect to production, or require production secrets.

## Hosted environment

The accepted workflow uses:

- pnpm `10.34.5` and Node.js `24.20.0`;
- GitHub-hosted `ubuntu-24.04` and `windows-2025` runners;
- `actions/checkout` v6.0.2, `pnpm/action-setup` v6.0.8, and
  `actions/setup-node` v6.5.0, each pinned by full commit SHA;
- a single stable branch-protection interface named `Release Gate Required`.

The two matrix display names are diagnostic details, not required checks. The
aggregator is intentionally the only supported required-check name and must remain
unique across the repository. The workflow grants only `contents: read`, installs
from the frozen lockfile, and uses a disposable PostgreSQL 16 instance when no test
database URL is supplied.

## Activation history

The first hosted `master` run at commit
[`119f03a`](https://github.com/freeloverodeheaver-byte/ai-math-learning/commit/119f03a)
was [run 34038311285](https://github.com/freeloverodeheaver-byte/ai-math-learning/actions/runs/34038311285).
The Windows job succeeded, but the Ubuntu job exited with code 1 after nine tests
failed. The three package scripts containing `dist/**` passed that glob unquoted,
so the POSIX shell expanded it and Vitest selected compiled tests. The fixed
aggregator consequently failed, as designed.

Commit
[`6bb9ad2`](https://github.com/freeloverodeheaver-byte/ai-math-learning/commit/6bb9ad2)
repaired exactly those three scripts by quoting their exclusion globs. An
independent review approved the repair. Before the repaired change was pushed, the
local Windows checkout passed type checking, all 232 repository tests, build, the
foundation gate (1 test), and CI configuration tests (4 tests). Those results
establish only the local Windows path; they do not replace hosted runner evidence.

[Pull request #1](https://github.com/freeloverodeheaver-byte/ai-math-learning/pull/1)
then completed
[run 34039037586](https://github.com/freeloverodeheaver-byte/ai-math-learning/actions/runs/34039037586)
successfully on both hosted platforms, including the `Release Gate Required`
aggregator. The pull request was merged into `master` as
[`b1841ef1b5fd015837d9948af665b33d71307469`](https://github.com/freeloverodeheaver-byte/ai-math-learning/commit/b1841ef1b5fd015837d9948af665b33d71307469).

## Acceptance status

The merged `master` commit was independently qualified by
[run 34039238144](https://github.com/freeloverodeheaver-byte/ai-math-learning/actions/runs/34039238144):
both platform jobs and the aggregator succeeded at
`b1841ef1b5fd015837d9948af665b33d71307469`.

[Ruleset 22389517](https://github.com/freeloverodeheaver-byte/ai-math-learning/rules/22389517)
is active for exactly `master`, requires the `Release Gate Required` check from
GitHub Actions (app ID `15368`), requires the branch to be up to date before
merging, and has no bypass actors. A repository rules query for `master` confirmed
that the Ruleset is effective and that the current user cannot bypass it. An
independent public-target review passed.

Negative acceptance used ordinary
[pull request #2](https://github.com/freeloverodeheaver-byte/ai-math-learning/pull/2)
at `feab557ce0907ef7bc9cfa382bdde924dc9a5842`. Its intentional configuration
probe left the four original configuration tests passing and added one deliberate
failure. In
[run 34039443519](https://github.com/freeloverodeheaver-byte/ai-math-learning/actions/runs/34039443519),
both platform jobs failed the probe and the aggregator failed. GitHub reported the
required check as failed and the non-draft pull request's merge state as `BLOCKED`.
This proves that a failed required gate blocks an ordinary pull request.

Recovery commit `419d74f47fa495d1a53eca279c71b2c9f47094d7` removed the intentional
test and the appended root command. The four configuration tests passed locally,
and an independent diff review confirmed that the recovery changes only removed
the probe machinery; relative to `master`, the pull request retained only
`docs/development/release-gate-probe.md`.

The recovery head then passed every step on both platforms and the aggregator in
[run 34039585431](https://github.com/freeloverodeheaver-byte/ai-math-learning/actions/runs/34039585431)
(attempt 1). GitHub reported `Release Gate Required` as passed and the ordinary,
non-draft pull request as `CLEAN` and `MERGEABLE`. This proves that the successful
required gate permits merging. Pull request #2 was subsequently closed without
merging; a readback confirmed `CLOSED` and not merged. Neither the intentional
failure probe nor its test command entered `master`.

The hosted `master` qualification, effective Ruleset, blocked negative case, and
permitted positive case are all verified. Release-gate activation is complete.

## Operating constraints

Keep the workflow's security and source guarantees intact: retain least-privilege
permissions, full-SHA action pins, frozen dependency installation, a disposable
test database, and one unique `Release Gate Required` source. Never place tokens,
production credentials, or production database URLs in workflow configuration or
acceptance evidence. On Windows, GitHub CLI operations may require the system proxy
to be exposed to the process through `HTTP_PROXY` and `HTTPS_PROXY`; documentation
and logs must never include proxy credentials or authentication tokens.

For diagnosis, reproduction, and safe retirement instructions, see
[CI release gate](ci-release-gate.md).
