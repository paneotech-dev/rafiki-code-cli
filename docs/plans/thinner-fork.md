# Plan: a thinner fork and a mechanical upstream merge

Branch `feature/thinner-fork`, cut from `review/cli-integration-2026-10-02`
(commit `ecc288d952`). This file is the plan the work follows. Nothing is
tagged, released or published from it, and no upstream merge is made here.

## Goal

The project follows the upstream project closely: a regular merge, and a fork
that stays thin. Two things make that cheap:

1. Fewer and smaller edits in files that upstream owns. Behaviour that belongs
   to this product lives in its own modules (`packages/core/src/brand/`,
   `packages/opencode/src/rafiki/`), and an upstream file carries at most a
   call into them.
2. A merge that is a procedure and not a discovery: the edits are listed with
   their reason, the list is checked by a test, and a script says before the
   merge which files will conflict and how each kind is resolved.

## What is measured

"Upstream-owned" means a file that exists in the upstream commit of the last
sync. "Edited" means the file differs from that commit here: modified,
renamed, deleted or changed in type. Files that exist only in this fork are
not counted, wherever they live.

The upstream commit of the last sync is
`a79ecfe109294909a239c98fb89f02979d5aa10b` (package version `1.18.34`), the
second parent of the merge commit `00b20e214d`.

Command: `git diff --numstat -M --diff-filter=MRDT <base>`, lines added plus
lines removed.

| | Upstream-owned files edited | Changed lines | Added | Removed |
| --- | ---: | ---: | ---: | ---: |
| Before (`ecc288d952`) | 178 | 6,552 | 3,689 | 2,863 |
| After | 177 | 6,342 | 3,603 | 2,739 |

## The nine follow-ups

A review of the October 2026 upstream sync listed nine follow-ups. Each is
taken here only if it is small, leaves behaviour unchanged, and can be proved
by a test. The rest is written up with the reason and a design.

| # | Follow-up | State on this line | Risk | Decision |
| --- | --- | --- | --- | --- |
| 1 | `installation/index.ts`: upgrade and install method detection are rewritten in place | open, 170 changed lines | high: the update path, and the upstream code it replaces carries upstream release addresses | not done, written up |
| 2 | `cli/cmd/uninstall.ts`: rewritten in place | open, 212 changed lines | low: one command, covered by the help snapshot and the shell path tests | done: the command moves to `src/rafiki/uninstall.ts`, the upstream file returns to upstream's text |
| 3 | `config/config.ts`: file names, schema address, substitution limits, trust | open, 86 changed lines; file names and schema address already come from the brand module | high: every remaining line is a trust or substitution hook | not done, written up |
| 4 | `acp/service.ts`: the cancellation fix is a behaviour fix, not branding | open, 89 changed lines | none here: it is a contribution to offer upstream | not done here, the candidate list is written up |
| 5 | `script/build.ts`: smoke test of every runnable target and the coverage report | open, 114 changed lines | medium: the release build; host detection for macOS and musl cannot be run on the development machine | not done, written up |
| 6 | `cli/cmd/gh.ts`, `gh.shared.ts`: files of this fork inside an upstream directory | open, 618 lines | low: a move | done: moved to `src/rafiki/` |
| 7 | `provider/provider.ts`: the key guard is one line inside an upstream function | open, 1 line | high if moved wrongly: it keeps the key on the gateway | not changed: one line is already the smallest hook; guarded by `test/rafiki/key-guard.test.ts` |
| 8 | No test scanned the interface sources for a new upstream name | closed by `test/brand/upstream-names.test.ts` | | nothing to do, verified |
| 9 | Sync cadence: the procedure existed only as the plan of one sync | open | low | done as tooling: `docs/upstream.md`, `script/upstream.mjs`, a manifest and a test |

## Work

### A. The list of edits, checked

- `script/upstream.json`: the upstream remote, branch and base commit, the
  classes of edited files with the rule for a conflict in each, one entry per
  edited upstream file (or per directory or pattern where one reason covers
  many files, such as the translated README files) with the reason, and the
  upstream files this fork replaces with a module of its own.
- `script/upstream.mjs` (plain Node, no dependency):
  - `check` (default): every edited upstream file is listed, every entry still
    matches an edit, every replaced upstream file is identical to upstream,
    and the table in `docs/upstream.md` is current. Exit 1 otherwise.
  - `write`: regenerates the table.
  - `report`: prints the two figures.
  - `conflicts <ref>`: a trial merge of an upstream ref in memory
    (`git merge-tree`), with the conflicts grouped by class and the rule for
    each, the files both sides changed that merge cleanly, the replaced files
    upstream changed, and workflows upstream added. It changes no branch and
    no file.
- `docs/check.mjs` runs the check when it is called without arguments, so the
  existing documentation check covers it. A clone that does not have the base
  commit (a shallow clone) skips it and says so.
- `packages/opencode/test/brand/upstream-files.test.ts`: runs the check on the
  repository, and proves on a small temporary repository that an edit that is
  not listed fails, a stale entry fails, an outdated table fails, an edit to a
  replaced file fails, and that `conflicts` classifies.

### B. `docs/upstream.md`

Public page: how the fork relates to upstream, where the fork's own code
lives, the generated table of edited upstream files with line counts and
reasons, the replaced files, and the merge procedure by file class.

### C. Uninstall (follow-up 2)

The fork's uninstall command moves, unchanged, to
`packages/opencode/src/rafiki/uninstall.ts`. `src/index.ts` registers it from
there. `src/cli/cmd/uninstall.ts` is restored to upstream's text and is not
imported by anything, as is already the case for the upstream GitHub agent
(`cli/cmd/github.handler.ts`). Proof: the help snapshot does not change, the
shell path and update tests pass, the manifest check proves the upstream file
is identical to upstream, and a test proves no source imports it.

Trade-off, stated in `docs/upstream.md`: a change upstream makes to its
uninstall command no longer conflicts, and no longer arrives. The `conflicts`
command lists replaced files that upstream changed, so a maintainer reads the
change at each merge.

### D. GitHub command (follow-up 6)

`src/cli/cmd/gh.ts` and `gh.shared.ts` move to `src/rafiki/gh.ts` and
`src/rafiki/gh.shared.ts`. Only import paths change. Proof: `test/cli/gh.test.ts`
and the help snapshot.

## Not done, with the design for later

1. **Installation (1).** A replacement of the whole service layer in
   `src/rafiki/` would leave the upstream file untouched, but the upstream
   file is imported by many modules, so it would stay in the binary together
   with upstream's installer and release addresses, which the binary must not
   contain. The smaller step is to move the fork's three bodies (`upgradeCurl`,
   the `latest` fallback, the `brew` and `winget` cases) behind
   `RafikiUpdate`, which saves about 40 lines and keeps the deletions. It
   touches the update path, so it wants a test against a mock release before
   and after.
2. **Configuration (3).** File names and the schema address already come from
   the brand module. What remains is substitution limits and workspace trust,
   which have to sit where the file is read. `normalizeLoaded` lives in
   `config/parse.ts` on purpose: `doctor` validates a file with the same
   function without loading the configuration layer.
3. **Fixes to offer upstream (4).** These edits are not specific to this
   product. If upstream takes them, the edit leaves the list: the `cancelled`
   stop reason for a turn cancelled before the model is called and the
   omitted `usage` for a message without token accounting (`acp/service.ts`,
   `acp/session.ts`, `acp/usage.ts`); the ACP defect written to stderr
   (`acp/error.ts`); the named error for an undefined layer node
   (`core/src/effect/layer-node.ts`); the buffered event source of the
   terminal interface (`cli/cmd/tui.ts`); the `abi` filter order for
   `--single --baseline` (`script/build.ts`); the input handling of
   `.github/workflows/close-prs.yml`.
4. **Build script (5).** Host detection, hashing and the report can move to a
   script of this fork called once after the build loop, before archives are
   made. It needs a release build of all twelve targets to prove, and the
   macOS and musl detection cannot be run on the development machine.
5. **Key guard (7).** Any other place to wrap the provider request is in the
   same upstream file and needs two call sites instead of one.
6. **Other candidates, outside the nine.** `cli/cmd/tui.ts` (76 lines, the
   buffered event source), `cli/error.ts` (42, `configFix`), `acp/error.ts`
   (25) and `skill/index.ts` (45) hold logic that could move behind a call.

## Verification

Heavy jobs run one at a time and at low priority, with a private copy of the
runtime first on `PATH` and a temporary home.

1. `bun turbo typecheck --concurrency=3`: 30 of 30.
2. `node docs/check.mjs`.
3. `packages/opencode`: `test/brand`, `test/cli/help` (no snapshot may
   change), `test/cli/gh.test.ts`; `packages/tui`.
4. The full `packages/opencode` suite once. Two failures are known and occur
   only when the suite runs as root: "continues loading tui config when legacy
   source cannot be stripped" and "tool.write > error handling > throws error
   when OS denies write access".
5. `node script/upstream.mjs conflicts <upstream ref>` against the current
   upstream branch, as a trial only.

## Out of scope

- An upstream merge.
- Any rename of something a user sees, any change to a configuration key, an
  environment variable, a wire identifier or a directory.
- Any tag, release or publication.

## Record

### What changed

| Commit | Change |
| --- | --- |
| `refactor(cli): move the gh commands into the folder of this fork` | `src/cli/cmd/gh.ts` and `gh.shared.ts` are now `src/rafiki/gh.ts` and `src/rafiki/gh.shared.ts`. Import paths only. |
| `refactor(cli): replace the upstream uninstall command instead of editing it` | The command is `src/rafiki/uninstall.ts`, identical to the edited file apart from two import paths and a header comment. `src/cli/cmd/uninstall.ts` is upstream's text again and nothing imports it. |
| `chore(upstream): record every edited upstream file and check the record` | `script/upstream.json`, `script/upstream.mjs`, `docs/upstream.md`, the hook in `docs/check.mjs`, `test/brand/upstream-files.test.ts`, one paragraph of the README. |

### Figures

Measured with `node script/upstream.mjs report` (and `--at ecc288d952` for
the first row), which runs the command given under "What is measured".

| | Upstream-owned files edited | Changed lines | Added | Removed |
| --- | ---: | ---: | ---: | ---: |
| Before (`ecc288d952`) | 178 | 6,552 | 3,689 | 2,863 |
| After | 177 | 6,342 | 3,603 | 2,739 |

One file left the list (`cli/cmd/uninstall.ts`, 212 lines) and `src/index.ts`
gained two changed lines for the two import paths. The fork-only layer grew
by the moved files; that is where the code belongs.

By class after the change: 35 files hold calls into this fork's modules (507
lines), 43 hold names and wording (360), 12 hold behaviour changed in place
(681), 33 are adapted tests (731), 3 are generated (547), 9 are package
identity (499), 23 are documentation (1,371), 6 are tooling (31) and 13 are
the editor extension (1,615). The twelve files with behaviour changed in
place are the ones worth thinning next.

### The nine follow-ups, final state

| # | State |
| --- | --- |
| 1 | Open. Not done; design above. |
| 2 | Done. |
| 3 | Open. Not done; what remains are trust and substitution hooks. |
| 4 | Open. An offer to upstream is outside this repository; the candidate list is above. |
| 5 | Open. Not done; design above. |
| 6 | Done. |
| 7 | Left as it is on purpose: one line, guarded by a test that drives a real run. |
| 8 | Already closed on this line by `test/brand/upstream-names.test.ts`. |
| 9 | The procedure is `docs/upstream.md` and the trial merge command. How often it is run is a matter of practice. |

### The trial merge, tried on real history

- Against the upstream branch as fetched on 2026-10-02 (`1ddb0873ae`): one
  upstream commit to merge, two files changed upstream, no conflict, no
  edited or replaced file touched.
- Replayed on the last sync (the `v0.1.9` tree against `a79ecfe109`, with the
  list of this branch): 126 commits, 277 files, and the same eight conflicts
  that sync resolved by hand, sorted as two calls, one wording file, one file
  with behaviour changed in place, one generated file, one package file, one
  extension file and one file that is no longer edited. It also named the
  nine files that merged cleanly on both sides and the one workflow upstream
  added, which is what that sync found by reading.

### Verification

| Step | Result |
| --- | --- |
| `bun turbo typecheck --concurrency=3` | 30 of 30 |
| `node docs/check.mjs` | passed, 31 files, with the upstream check |
| `packages/opencode`: `test/brand`, `test/cli/help`, `test/cli/gh.test.ts`, `test/installation` | 222 pass, 0 fail, 45 snapshots, none changed |
| `packages/tui` | 204 pass, 1 skip, 0 fail |
| Full `packages/opencode` suite, once | 4,274 pass, 22 skip, 1 todo, 2 fail of 4,299 in 306 files. The two failures are the two known ones that occur only as root. |

Not run: the installer tests and a binary build. No installer, build script
or workflow is changed by this branch.
