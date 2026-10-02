# Upstream sync, October 2026

This is the plan for the first merge of the upstream project into this fork
since the fork point. It records what is merged, how conflicts are resolved,
and what is checked afterwards, so the same procedure can be repeated.

## Scope

- Base: the `v0.1.9` release line (commit `a73793dd25`).
- Branch: `feature/upstream-sync-2026-10`.
- Upstream: the `dev` branch of the `upstream` remote at commit
  `a79ecfe109294909a239c98fb89f02979d5aa10b` (package version `1.18.34`).
- Merge base before the sync: `95daf90670b7c039c436c85537da5fbfe2205b41`
  (package version `1.18.30`), 126 upstream commits behind.

The result is one branch for review. Nothing is tagged, released or merged
into another branch by this work.

## Method

1. Fetch the upstream branch without tags. Upstream tags are not imported and
   no existing tag is moved or deleted.
2. Merge with a real merge commit (no rebase, no squash) so that later syncs
   have a merge base.
3. Resolve each conflict by taking the upstream code and reapplying the fork's
   change as the smallest possible touchpoint. Where a fork rewrite could be
   reduced to a one-line call into `packages/opencode/src/rafiki/` or
   `packages/core/src/brand/`, record it as a follow-up instead of refactoring
   during the merge, unless the conflict forces it.
4. Regenerate `bun.lock` with `bun install` instead of merging it by hand, and
   confirm that the fork adds no dependency beyond those it already carried.
5. Keep the fork's own package versions and names where both sides changed
   them (for example `packages/opencode/package.json` and
   `sdks/vscode/package.json`).

## Files expected to conflict

A trial merge reports conflicts in eight files:

- `bun.lock` (regenerated)
- `packages/core/src/filesystem/search.ts`
- `packages/opencode/package.json`
- `packages/opencode/script/build.ts`
- `packages/opencode/src/cli/cmd/web.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/tui/src/app.tsx`
- `sdks/vscode/package.json`

Nine more files changed on both sides and merge without conflict. They are
reviewed by hand as well, because a clean textual merge can still change
behaviour:

- `package.json`
- `packages/opencode/src/cli/cmd/tui.ts`
- `packages/opencode/src/provider/transform.ts`
- `packages/opencode/src/session/llm/request.ts`
- `packages/opencode/test/cli/run/run-process.test.ts`
- `packages/tui/src/component/dialog-status.tsx`
- `packages/tui/src/util/error.ts`
- `packages/tui/test/app-lifecycle.test.tsx`
- `packages/web/package.json`

## Checks after the merge

Things an upstream change can undo without a conflict:

- Brand: nothing visible to a user names the upstream project outside
  `LICENSE`, `NOTICE` and the README attribution section.
- Seeded defaults: automatic update behaviour and the update source point at
  this project's releases only.
- `upgrade --method` offers only the methods this fork supports.
- A rejected command line argument prints its reason.
- `doctor` checks and their wording.
- Restart from a temporary directory mounted `noexec`.
- Help output snapshots.
- ACP cancellation.
- Workspace trust.
- `install/` scripts and the release workflows. Workflows inherited from
  upstream, including any added by this merge, must stay inert in this
  repository.

## Verification

Run in this order, one heavy job at a time:

1. `bun turbo typecheck --concurrency=3 --force`
2. Targeted suites in `packages/opencode`: `test/brand`, `test/rafiki`,
   `test/cli/help`, `test/installation`, `test/cli/acp`, `test/acp`,
   `test/config`; and `packages/core/test/brand`.
3. The full `packages/opencode` suite once. Two failures are known and occur
   only when the suite runs as root: "continues loading tui config when legacy
   source cannot be stripped" and "tool.write > error handling > throws error
   when OS denies write access". Any other failure is compared against the same
   test at `v0.1.9` before it is called existing.
4. `node docs/check.mjs`
5. `install/test-install.sh`, `install/test-install-shells.sh`,
   `install/test-install-url.sh`
6. Build one binary for the host and run it: `--version`, `--help`, `doctor`
   with no network, and a rejected flag.

## Stop conditions

The work stops and is reported, without forcing a result, if the sync needs
more than conflict resolution: an upstream refactor that removes a seam the
`rafiki` layer depends on, or conflicts in core files well beyond the eight
listed above. In that case the branch is pushed in its actual state and marked
as incomplete.

## Out of scope

- Refactors that thin the fork (recorded as follow-ups only).
- Any tag, release or publication.
- Changes to other feature branches.
