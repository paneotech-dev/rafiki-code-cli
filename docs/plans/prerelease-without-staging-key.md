# Plan: a pre-release runs without the staging key

Branch `fix/prerelease-without-staging-key`, based on
`review/cli-integration-2026-10-02` at `af2dc26482`. Written before any other
file was edited.

## What happened

The tag `v0.1.10-rc.1` started run 37193458349 of `.github/workflows/release.yml`.
It stopped in `preflight`, at the step "Require every secret the release needs":
the repository secret `RAFIKICODE_STAGING_API_KEY` is not set. Nothing was
built. That secret is the only one a pre-release asks for today, and it is used
by two of the five checks the gate makes on each build. So the macOS signing,
Apple's `codesign --verify --strict` on the macOS runners, the gate's offline
checks and the install matrix, none of which need the key, did not run either.

## What the gate checks, and which checks need the key

`install/release-gate.sh` (Linux and macOS, through
`install/release-gate-probe.sh`) and `install/release-gate.ps1` (Windows) record
five facets per build:

| Facet | Needs the staging key |
| --- | --- |
| `install` the documented install from the built archives | no |
| `version` `--version` prints the version being released | no |
| `licence` `rafikicode licenses` and the LICENSE and NOTICE files | no |
| `signin` `rafikicode whoami` with the key names an account on staging | yes |
| `task` one `rafikicode run` task against the staging gateway | yes |

Outside the gate scripts, and not using the key: the SHA256SUMS check of the
archive before anything is installed (both scripts), the page hash check of the
macOS signatures in the build job, `codesign --verify --strict` in the macOS
gate jobs, and the install matrix (`install-matrix.yml`, whose probe runs
`doctor` without a credential and starts the interface on a pseudo terminal).
Neither gate script has an offline equivalent of `signin` or `task`, so there is
none to keep.

## What changes

1. `preflight`: for a pre-release (a version with a hyphen) no secret is
   required. When `RAFIKICODE_STAGING_API_KEY` is absent it outputs
   `live_gate=false`, writes a warning annotation and the step summary line
   "Pre-release without the staging key: live checks against staging are
   skipped; every other check runs", and continues. Otherwise
   `live_gate=true`. A full release still requires all four secrets and stops
   as today.
2. The gate scripts take an explicit switch, `--no-live` for
   `release-gate.sh` and `-NoLive` for `release-gate.ps1`. Without it, a
   missing or empty key stops the gate with exit 2, as today, so a mistyped or
   unset secret never skips anything by itself. With it:
   - the gate refuses (exit 2) a version without a pre-release part, and a key
     that is set (the switch and a key contradict each other);
   - `install`, `version` and `licence` run as before;
   - `signin` and `task` are not run and are recorded in the verdicts file as
     `skipped (no staging key, pre-release)`, never as `pass`;
   - any other facet that does not report `pass` still fails the gate.
   The probe learns the mode from `GATE_LIVE=0`, set only by the gate, and
   reports `skipped` for those two facets; the gate accepts a `skipped` only
   for them and only in this mode.
3. The workflow passes `--no-live` / `-NoLive` to the gate jobs only when
   `preflight` said `live_gate=false`.
4. `publish`: the gate record accepts `skipped (no staging key, pre-release)`
   for `signin` and `task`, and only when the run is a pre-release with
   `live_gate=false`; every other verdict must still be `pass`, with the same
   13 builds and 65 verdicts. The release notes of such a pre-release end with
   the line "Live checks against staging were skipped for this pre-release
   because the staging key is not configured." Full releases are unchanged.
5. Docs: `docs/install.md`, section For maintainers, states the rule. The
   README release section does not describe the secrets and is not changed.
6. Tests: `install/test-release-gate.sh` gains cases for the no-live mode
   (exactly `signin` and `task` skipped and recorded as skipped, the other
   three run and pass, a bad build still fails, the switch is refused for a
   full version and when a key is set) and keeps the case where a missing key
   without the switch stops the gate.

## Checks before pushing

`install/test-release-gate.sh`, `install/test-install.sh`,
`install/test-install-shells.sh`, `install/test-install-url.sh`, the
PowerShell gate in a throwaway `mcr.microsoft.com/powershell` container as far
as it runs off Windows, PyYAML on the workflows, `actionlint` when it can be
fetched as one static binary, `node docs/check.mjs`,
`bun turbo typecheck --concurrency=3`, `test/brand` and `test/installation`.
