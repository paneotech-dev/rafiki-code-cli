# Plan: integration line for the five October 2026 feature branches

Branch `review/cli-integration-2026-10-02`, cut from `v0.1.9`
(commit `a73793dd25`). This file is the plan the work follows. The branch
exists so the five branches can be reviewed as a set. Nothing is tagged,
released or published from it, and none of the five branches is changed.

## Branches and order

Each is merged with a real merge commit (no squash, no rebase), in this
order:

| Order | Branch | Head |
| --- | --- | --- |
| 1 | `feature/upstream-sync-2026-10` | `394d187172` |
| 2 | `feature/install-channels` | `0225d0f37a` |
| 3 | `feature/network-resilience` | `9962f5ed6d` |
| 4 | `feature/cache-friendly-prefix` | `2b964417da` |
| 5 | `feature/cost-display` | `0d43f09b2e` |

The upstream sync goes first because it moves the code the other four hook
into (request assembly, the provider fetch wrapper, the command list).

## Rules for a conflict

- Keep both behaviours. Where two branches changed the same hook site, the
  two calls are composed and the order is recorded below with the reason.
- `CHANGELOG.md` is added by every branch: one `# Changelog` heading, every
  branch's line, in merge order.
- `bun.lock` is not merged by hand. It is regenerated with
  `bun install --ignore-scripts` after the merge that touches it.
- `packages/opencode/package.json` keeps the fork's name and version fields
  as the upstream sync branch resolved them.
- The help snapshot is regenerated from the merged command list and compared
  with each branch's own additions, not merged line by line.
- A branch that fails on its own is not repaired here. The failure is
  recorded for that branch. Only what the combination breaks is resolved.

## Expected overlaps

| File | Branches |
| --- | --- |
| `CHANGELOG.md` | all five |
| `bun.lock` | upstream sync, install channels |
| `packages/opencode/package.json`, `packages/opencode/script/build.ts` | upstream sync, install channels |
| `packages/core/src/brand/brand.ts` | install channels, cache prefix, cost display |
| `packages/opencode/src/session/prompt.ts` | network resilience, cache prefix |
| `packages/opencode/src/cli/cmd/run.ts` | network resilience, cost display |
| `packages/opencode/src/index.ts` | install channels, cost display |
| help snapshot under `packages/opencode/test/cli/help/` | install channels, network resilience, cost display |
| `packages/opencode/test/brand/mock-gateway.mjs` | cache prefix, cost display |
| `docs/configuration.md`, `docs/troubleshooting.md`, `docs/quickstart.md`, `docs/headless-and-ci.md` | several |

## Checks after each merge

The suites the merged branch owns, plus `packages/opencode/test/brand`, so a
break is attributed to the merge that caused it:

1. Upstream sync: `test/brand`, `test/rafiki`, `test/cli/help`,
   `test/installation`, `test/config`; `packages/core/test/brand`.
2. Install channels: `test/rafiki/autoupdate.test.ts`, `test/brand`,
   `test/installation`, `test/cli/help`; `install/test-install.sh`,
   `install/test-release-gate.sh`.
3. Network resilience: `test/rafiki/network-resilience.test.ts`,
   `test/rafiki/resilience.test.ts`, `test/rafiki/resume.test.ts`,
   `test/brand`, `test/cli/help`.
4. Cache prefix: `test/rafiki/cache-prefix.test.ts`, `test/rafiki`,
   `test/brand`.
5. Cost display: `test/rafiki/tier-headers.test.ts`,
   `test/rafiki/cost.test.ts`, `test/rafiki/usage.test.ts`, `test/brand`,
   `test/cli/help`; `packages/core/test/brand`; the cost plugin test in
   `packages/tui`.

## Checks on the set, after the last merge

Things that can break without a conflict when the branches meet:

- Request body: the stable prefix is byte identical between two requests of a
  task, with the continuation instruction of a resumed stream and the tier
  headers in play. The continuation instruction belongs to the conversation,
  after the stable part, and must not move the cache marker.
- `Idempotency-Key`: equal on an identical request sent again, different on a
  continuation.
- `X-Rafiki-Tier` and `X-Rafiki-Escalation` are on the wire next to
  `X-Rafiki-Surface` on a normal request, a retried request and a
  continuation.
- The cache marker and the date line land where
  `docs/plans/cache-friendly-prefix.md` says, after the upstream sync moved
  request assembly.
- The updater refuses to replace the executable of a run from source.
- `upgrade --method` choices and the help snapshots agree with the merged
  command list (`licenses`, `usage`, `--resume`).
- Nothing visible to a user names the upstream project.
- `node docs/check.mjs` passes, and `docs/install.md`,
  `docs/configuration.md` and the troubleshooting pages say the same thing
  about `update`, `--resume` and `usage`.

Where no existing test covers one of these across branches, a test is added
under `packages/opencode/test/rafiki/` on this branch.

## Verification at the end

Heavy jobs run one at a time and at low priority:

1. `bun turbo typecheck --concurrency=3 --force`
2. The full `packages/opencode` suite, once. Two failures are known and occur
   only when the suite runs as root: "continues loading tui config when
   legacy source cannot be stripped" and "tool.write > error handling >
   throws error when OS denies write access". Any other failure is run on the
   individual branches to find the merge that introduced it.
3. `packages/tui` suite and `packages/core/test/brand`.
4. `install/test-install.sh`, `install/test-install-shells.sh`,
   `install/test-install-url.sh`, `install/test-release-gate.sh`.
5. One `linux-x64` binary, then: `--version`, `--help` and the help of each
   subcommand without the upstream name, `doctor` with no network, a rejected
   flag printing its reason, `usage --help`, `licenses`, and `run --help`
   listing `--resume`.

## Safety of the test runs

- Data, configuration, cache and install prefixes point at temporary
  directories. No test run writes to a real home directory, a system binary
  directory or the runtime that executes the tests.
- `update`, `upgrade` and `uninstall` are exercised only against a mock
  release with a temporary prefix.
- No live sign-in and no live model call. Mock servers bind free loopback
  ports and are stopped afterwards.

## Stop condition

If the set cannot pass without changing what one branch does, the branch
stops at the last merge that passes, and the record says which branch is out
and why.

## Record

The conflicts met and how each was resolved are appended here after each
merge.
