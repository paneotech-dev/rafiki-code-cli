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

### Merges

| Order | Branch | Merge commit | Textual conflicts |
| --- | --- | --- | --- |
| 1 | `feature/upstream-sync-2026-10` | `f04a8870f4` | none |
| 2 | `feature/install-channels` | `9476dba3d5` | `CHANGELOG.md` |
| 3 | `feature/network-resilience` | `b57d65d364` | `CHANGELOG.md` |
| 4 | `feature/cache-friendly-prefix` | `9533083153` | `CHANGELOG.md` |
| 5 | `feature/cost-display` | `a33a4c8887` | `CHANGELOG.md`, `packages/opencode/src/index.ts`, `packages/opencode/test/brand/mock-gateway.mjs`, `packages/tui/src/app.tsx` |

`bun install --ignore-scripts` reported no change to `bun.lock` after any
merge: only the upstream sync changes it, and its lock file was taken as it
is.

### Conflicts and resolutions

- `CHANGELOG.md` (merges 2 to 5, add/add): one `# Changelog` heading and
  every branch's line, in merge order.
- `packages/opencode/src/index.ts` (merge 5): both branches added a name to
  the same import from `./rafiki/cmd`. The import names `LicensesCommand` and
  `UsageCommand`; both commands are registered, `usage` after `whoami` and
  `licenses` after `doctor`, where each branch put its own.
- `packages/opencode/test/brand/mock-gateway.mjs` (merge 5): both branches
  added options to the mock. All three are kept: `bodies` (cache prefix),
  `prices` and `usage` (cost display).
- `packages/tui/src/app.tsx` (merge 5): the upstream sync sets the exit code
  when the interface ends with an error; the cost display appends the cost
  line to the text printed on exit. Both are kept: the exit code block as the
  sync has it, then the exit text followed by the cost line.

### Hook sites shared without a textual conflict

- `packages/opencode/src/session/prompt.ts`: the history passes through
  `RafikiResume.withContinuations` before it becomes model messages (network
  resilience), and the system parts are ordered by `CachePrefix.order` (cache
  prefix). The two calls sit on adjacent statements and do not depend on each
  other: the first shapes the conversation, the second the system text.
- Request headers: `X-Rafiki-Tier` and `X-Rafiki-Escalation` are set on the
  model entry (`Brand.provider.config`), and `RafikiResilience.stamp` adds
  `Idempotency-Key` to a copy of the same header map, so a request carries
  all of them next to `X-Rafiki-Surface`.
- `packages/core/src/brand/brand.ts`, `packages/opencode/src/cli/cmd/run.ts`,
  `packages/opencode/src/session/llm/request.ts`,
  `packages/opencode/src/provider/transform.ts` and the help snapshot merged
  without a conflict and were read after the merge.

### What broke only in combination

- `packages/opencode/test/rafiki/resume.test.ts` (network resilience) counted
  every request that passed through its proxy. With the cost display merged,
  `run` reads the price list from the gateway when it starts
  (`GET /v1/model/info`), so the test saw three requests where it expected
  the two model requests. It passes on its own branch and after merge 4, and
  fails from merge 5. The test now counts only requests to
  `/v1/chat/completions`. No behaviour was changed.
- `docs/cost.md` (cost display) says every request carries three headers.
  With network resilience merged, the requests of a task also carry
  `Idempotency-Key`. One sentence pointing at
  `docs/contracts/idempotency-key.md` was added under the table.

### Test added on this branch

`packages/opencode/test/rafiki/integration-set.test.ts` runs the real session
loop against a scripted local model through the connection cutting proxy, on
a marked tier (`rafiki-max`) and an unmarked one (`rafiki-fast`):

- after a stream cut in the middle of text, the continuation request starts
  with the same bytes as the first request up to the end of the stable system
  message, sends the same tool definitions, keeps the date line in the second
  system message, and carries the partial answer and the instruction to
  continue as conversation, after both system messages;
- on the marked tier the marker closes the stable prefix and appears nowhere
  before its end; on the unmarked tier no request contains one;
- every request carries `X-Rafiki-Surface`, `X-Rafiki-Tier` and
  `X-Rafiki-Escalation`; a continuation carries a new `Idempotency-Key`, and
  a request sent again after a refused connection is the same bytes under the
  same key and the same headers.

### Results

Run on the head of this branch unless a merge is named.

| Check | Result |
| --- | --- |
| After merge 1: `test/brand`, `test/rafiki`, `test/cli/help`, `test/installation`, `test/config` | 658 pass, 3 skip, 1 fail (the known root only failure in `test/config`) |
| After merge 1: `packages/core/test/brand` | 10 pass |
| After merge 2: `test/rafiki/autoupdate.test.ts`, `test/brand`, `test/installation`, `test/cli/help` | 216 pass, 0 fail |
| After merge 2: `install/test-install.sh`, `install/test-release-gate.sh` | 54 and 16 passed, 0 failed |
| After merge 3: the three network resilience files, `test/brand`, `test/cli/help`, `test/session` | 600 pass, 7 skip, 0 fail |
| After merge 4: `test/rafiki`, `test/brand`, `test/session`, `test/provider` | 1670 pass, 7 skip, 0 fail |
| After merge 5: the cost display files, `cache-prefix`, `network-resilience`, `test/brand`, `test/cli` | 621 pass, 5 skip, 0 fail |
| After merge 5: `packages/core/test/brand`, the cost plugin test in `packages/tui` | 39 pass; 9 pass |
| `packages/opencode` typecheck after each merge | pass |
| `bun turbo typecheck --concurrency=3 --force` | 30 of 30 tasks |
| Full `packages/opencode` suite, once | 4241 pass, 22 skip, 3 fail: the two known root only failures and the resume test described above, which passes after the change to it |
| `packages/tui` suite | 203 pass, 1 skip, 0 fail |
| `install/test-install.sh`, `test-install-shells.sh`, `test-install-url.sh`, `test-release-gate.sh` | 54, 10, 54 and 16 passed, 0 failed |
| `node docs/check.mjs` | pass |
| `linux-x64` binary | builds; `--version`, `--help` and the help of every subcommand without the upstream name; `doctor` with no network reports the gateway and the console as unreachable and exits 4; an unknown flag and an invalid value print their reason; `usage --help`, `licenses`; `run --help` lists `--resume` |

### Left for the branches

Found on the first pass, on a branch by itself, and not changed here. Each
was then fixed on its branch and came in with the follow-up merges below.

- `feature/install-channels`: `docs/troubleshooting.md` advised
  `--method curl` for a copy run from source, while the branch makes `update`
  install nothing from a run from source by any method. The help of
  `licenses` had no snapshot. `upgrade --method` listed `choco` and `scoop`
  as choices and refused both.
- `feature/cost-display`: `summarize` in `packages/core/src/brand/cost.ts`
  skipped a model call with no token counts, so a call whose stream was cut
  before its usage block was left out of the estimate without a word. With
  network resilience merged, a cut is followed by a continuation, so this
  could happen on a task that completes.

## Follow-up merges

Both branches gained fix commits for the items above and were merged again,
each with a real merge commit.

| Order | Branch | Head | Merge commit | Textual conflicts |
| --- | --- | --- | --- | --- |
| 6 | `feature/install-channels` | `da5eb17053` | `990312a08a` | none |
| 7 | `feature/cost-display` | `2a6625604c` | `8d47959d4b` | none |

- The help snapshot merged without a conflict and was not regenerated: the
  help test passes against it as merged. It holds the entries of every
  branch: `licenses`, `usage`, `--resume` on `run`, and `upgrade --method`
  with the choices `curl`, `npm`, `pnpm`, `bun`, `brew`, `winget`.
- `docs/troubleshooting.md` and `docs/cost.md` merged without a conflict; the
  sentence about `Idempotency-Key` added on this branch is kept.
- `packages/opencode/test/rafiki/integration-set.test.ts` gained one test of
  the interaction the cost fix was made for: `rafikicode run` through the
  connection cutting proxy, the first model request cut after two words. The
  task completes with a continuation, and the closing line reads
  `Task cost: tier fast · about 0.0086 USD (estimate) · 1 call reported no usage and is not included · caching saved about 0.0054 USD · at most about 12.39 USD of credits left`.

### Results after the follow-up merges

| Check | Result |
| --- | --- |
| `bun turbo typecheck --concurrency=3 --force` | 30 of 30 tasks |
| Full `packages/opencode` suite, once | 4245 pass, 22 skip, 2 fail: the two known root only failures and nothing else |
| `packages/tui` suite | 204 pass, 1 skip, 0 fail |
| `packages/core/test/brand` | 46 pass |
| `node docs/check.mjs` | pass |
| `install/test-install.sh`, `test-install-shells.sh`, `test-install-url.sh`, `test-release-gate.sh` | 54, 10, 54 and 16 passed, 0 failed |
| `linux-x64` binary, rebuilt | `upgrade --help` lists the six methods above; `licenses --help` prints its help; the earlier checks hold |
