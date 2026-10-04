# Plan: valid macOS signatures, and the installer defects found with them

Branch `fix/release-signing`, based on `review/cli-integration-2026-10-02` at
`fa39383a4c`. Written before any other file was edited.

## What is wrong in 0.1.9

The release builds all twelve binaries on one Linux runner
(`.github/workflows/release.yml`, job `build`, `ubuntu-24.04`, which runs
`packages/opencode/script/build.ts`). `build.ts` signs a macOS build only when
the build host is a Mac (`codesign --force --sign -`), so on the release runner
nothing signs them, and the archives carry whatever signature the compiler left:

| Build | Signature in the 0.1.9 archive | Page hashes that do not match |
| --- | --- | --- |
| darwin-arm64 | ad hoc, written by the compiler | 1 of 35,082: the last page, hashed as if padded with zeros to 4,096 bytes |
| darwin-x64, darwin-x64-baseline (same bytes) | the Developer ID signature of the Bun runtime it was built from, covering the first 68,617,792 bytes of a 150,306,896 byte file | 55 of 16,753, page 0 among them |

macOS checks code signatures when it maps pages, not only through Gatekeeper,
and Apple Silicon refuses to run code without a valid signature. Neither build
has ever been started on a Mac: the gate jobs that would have done so did not
run for 0.1.8 or 0.1.9.

Also found in the same tests:

- `install/install.sh` says, at `clear_quarantine`, that the builds are "ad-hoc
  signed only". It was true for arm64 only.
- `install/install.ps1` exits 0 when the program it installed does not run, so
  a script calling it cannot tell. Without `USERPROFILE` it stops with a
  PowerShell binding error instead of a message.
- The Windows executables say "Bun" by "Oven" in their version resource.
- The docs do not say that the macOS builds need macOS 13 or newer, that the
  macOS and Git Bash routes need `unzip`, or where `install.ps1` is fetched from.

## What this branch changes

1. Signing, after the binary is final. `build.ts` calls one function of a new
   fork module, `packages/opencode/script/macos-signature.ts`, right after
   `Bun.build` writes a darwin binary and before it is started and hashed (so the
   hash in `PLATFORM-COVERAGE.md` is the hash of the signed file):
   - on a Mac it runs `codesign --force --sign -`, as before;
   - elsewhere it runs `rcodesign sign --binary-identifier rafikicode`, an ad
     hoc signature written by the apple-codesign project's tool, when
     `rcodesign` is on `PATH`;
   - with `RAFIKICODE_REQUIRE_MACOS_SIGNATURE=1` (set by the release workflow)
     a missing signer is fatal.
   It then checks the result itself (below) and stops the build when the
   signature is not valid.
2. The check, `macos-signature.ts` run as a script or called from `build.ts`:
   reads the Mach-O, finds the code signature, and requires an ad hoc
   signature whose CodeDirectory uses SHA-256, covers the whole file up to the
   signature, and records the right hash for every page and for every special
   slot that has a blob. No dependency: `node:fs` and `node:crypto`.
3. Release workflow, job `build`: a step installs `rcodesign` 0.29.0 from the
   project's GitHub release, pinned by SHA-256; the build step sets
   `RAFIKICODE_REQUIRE_MACOS_SIGNATURE=1`; after packing, a gate step unpacks
   the three darwin zips and runs the check on the binaries exactly as shipped.
   `rcodesign verify` is not used as the gate: 0.29.0 rejects its own ad hoc
   signatures ("CMS error: missing further values") and says of itself that
   the command is known to be buggy.
4. Release workflow, job `gate`, macOS runners: before the install, Apple's
   own `codesign --verify --strict --verbose=2` on the binary in the archive.
   A failure fails the job, and `publish` needs every gate job.
5. `install.sh`: the comment says what is now true.
6. `install.ps1`: exits 1 with a message when the installed program does not
   run; checks `USERPROFILE` up front, when no `-Prefix` or
   `RAFIKICODE_INSTALL_DIR` names the directory, and says the installer is for
   Windows when it is missing. Found while testing this: the check piped the
   program's output into `Select-Object -First 1`, which stops reading early and
   leaves `LASTEXITCODE` at 0, so a program that printed a line and then failed
   passed it. The output is now collected whole before the exit code is read.
7. Windows metadata: Bun documents `compile.windows.title`, `publisher`,
   `version`, `description` and `copyright`, and also documents that they
   "cannot be used when cross-compiling because they depend on Windows APIs".
   The Windows builds are cross compiled on the Linux runner. A trial on Linux
   with Bun 1.4.2 confirmed it: the build succeeds without a warning and the
   resource still says Bun and Oven. So nothing is changed for it here; it
   would need the Windows builds to move to a Windows runner.
8. Docs: README, `docs/install.md`, `docs/troubleshooting.md`.
9. CHANGELOG lines for the user visible changes; `script/upstream.json` reason
   for `build.ts` updated and the table regenerated.

## Proof that can be given here

The published 0.1.9 darwin binaries, re-signed with `rcodesign` 0.29.0 in a
throwaway container, then checked by the new module: every page hash matches on
both architectures. Unit tests build small Mach-O files in memory and show the
check refuses each defect of 0.1.9 (a padded last page, a signature that covers
part of the file, a Developer ID signature) and accepts a correct one.

## Proof that needs a Mac or Windows

- That macOS starts the re-signed binaries (`codesign --verify --strict` and a
  launch). The gate jobs on `macos-15` and `macos-15-intel` do this on the next
  tagged release.
- The darwin-x64 builds keep the hardened runtime flag and the runtime's
  entitlements (`allow-jit` and the others Bun ships with), because `rcodesign`
  carries them over from the signature it replaces. That is how the Bun runtime
  itself is signed, now ad hoc instead of Developer ID; only a Mac shows it runs.
- `install.ps1` on real Windows.

## Results

Run on 4 October 2026, with a private copy of the runtime first on `PATH`.

Signatures of the published 0.1.9 builds, before and after `signMacOSBinary`
(`rcodesign` 0.29.0, in a throwaway container), checked by
`macos-signature.ts`:

```text
before
darwin-arm64: code directory: 1 of 35082 page hashes do not match (pages 35081)
darwin-x64: the signature carries a certificate signature: it is not ad hoc
darwin-x64: code directory: flags 0x10000 do not include ad hoc
darwin-x64: code directory: names a team (7FRXF46ZSN): it is not ad hoc
darwin-x64: code directory: covers 68617792 bytes, but the signature starts at 149751360
darwin-x64: code directory: 55 of 16753 page hashes do not match (pages 0, 16699, 16700, ..., 16750, 16751, 16752)
after
darwin-arm64: valid ad hoc signature, identifier rafikicode, flags 0x2, all 35082 page hashes match, covers 143694512 of 144822960 bytes
darwin-x64: valid ad hoc signature, identifier rafikicode, flags 0x10002, all 36561 page hashes match, covers 149751360 of 150927936 bytes
```

darwin-x64-baseline is the same bytes as darwin-x64 before and after. An
independent page hash script written for the platform tests agrees: 0
mismatched pages on all three. The workflow step that checks the archives
passes on archives of the re-signed binaries and fails (exit 1) when the 0.1.9
arm64 archive is put back. The workflow step that installs `rcodesign` was run
as written: checksum OK, `apple-codesign 0.29.0`.

`install.ps1` under PowerShell 7 for Linux, against a local mirror: without
`USERPROFILE` it prints the new message and exits 1 (before: the binding
error); a working build exits 0; a build that prints a line and exits 3 now
exits 1 (before: "Verified" and exit 0); the real 0.1.9 windows-x64 archive,
which cannot run on Linux, exits 1.

Tests: installer suites 54, 10, 54 and 16 passed, none failed; `test/brand`,
`test/installation`, `macos-signature` and `platform-coverage` 222 passed;
`bun turbo typecheck --concurrency=3` 30 of 30; full `packages/opencode` suite
4,284 pass, 22 skip, 1 todo, 2 fail of 4,309 in 307 files, the two failures
being the known ones that occur only as root. `node docs/check.mjs` passed.
