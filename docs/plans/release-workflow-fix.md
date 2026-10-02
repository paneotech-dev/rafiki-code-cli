# Plan: the release runs of 0.1.8 and 0.1.9 ended failed

Branch `fix/release-workflow`, based on `feature/cli-small-fixes` at
`29cbfec49f`. Written before any other file was edited.

## What happened

The release runs for `v0.1.8` (run 36939229079) and `v0.1.9` (run 36941078961)
published their archives and installers, and both runs ended with the
conclusion `failure`. Neither run has a failed job. Each has two job records:
`build all platforms` (success) and `publish npm packages` (skipped). The job
`install matrix` has no record at all, and the run carries one error
annotation:

```text
Canceling since a deadlock was detected for concurrency group: 'release-refs/tags/v0.1.9' between a top level workflow and 'install matrix'
```

The cause is in the two workflow files as they were on those tags.
`release.yml` declared `concurrency: ${{ github.workflow }}-${{ github.ref }}`.
`install-matrix.yml`, called from it with `uses:`, declared the group
`${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}`.
In a called workflow `github.workflow` is the name of the caller, so both
expressions gave `release-refs/tags/v0.1.9`: the called job waited for a group
its own run was holding, and GitHub ended the run. The matrix never started,
`INSTALL-MATRIX.md` was never attached to either release, and the npm job was
skipped because it needed the matrix.

## State of this line

The defect is not present here. Commit `f3336319ff` gave the called workflow a
group of its own:

- `.github/workflows/release.yml`: `concurrency: ${{ github.workflow }}-${{ github.ref }}`,
  which is `release-refs/tags/v<version>` on a tag.
- `.github/workflows/install-matrix.yml`:
  `group: install-matrix-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}`,
  which is `install-matrix-release-refs/tags/v<version>` when the release
  workflow calls it.

The two strings differ, no job in either file declares a group of its own, and
`install-matrix.yml` is the only workflow called with `uses:`. Commit
`b4db1d336f` also moved the matrix and the gate ahead of the publish job, so a
run stopped this way would publish nothing.

So neither workflow file is changed on this branch. The correction has not
been exercised: the release workflow runs only on a pushed tag, and no tag has
been pushed from this line.

## What this branch changes

Documentation only, in `docs/install.md`, section For maintainers:

- A release counts as published and verified only when the run conclusion is
  `success` and the assets and the installer have been checked. Assets that
  download are not enough: that was true of 0.1.8 and 0.1.9.
- The two `gh` commands that give the run conclusion and the conclusion of
  every job, the job conclusions to expect, and the check of the assets and of
  the installer address.
- What the failure of 0.1.8 and 0.1.9 looks like, so that it is recognised: a
  failed run with no failed job and no record for `install matrix`.

No behaviour changes, so `CHANGELOG.md` gets no line.

## Checks

- `node docs/check.mjs` passes.
- Both workflow files still parse as YAML, and the two group expressions are
  compared as text. `actionlint` is used if it is already on the machine.
- The shell suites under `install/` are not run: nothing they cover is touched.

## Not proved by this branch

That a release run on this line ends `success`. Only a pushed tag proves it.
The check to make on that run is the one this branch writes into
`docs/install.md`.
