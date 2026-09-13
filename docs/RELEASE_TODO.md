# Release checklist and open items

This file tracks what the release pipeline (`.github/workflows/release.yml`,
`install/install.sh`, `rafikicode update`, `packages/opencode/script/publish-npm.ts`)
still needs before a public beta. Items are owned by the project owner unless
stated otherwise.

## Before the first public tag

- Create the GitHub repository `paneotech-dev/rafiki-code-cli` and push this
  fork (the staging box only holds a repository scoped deploy key, so the push
  is done by the owner).
- Point `get.rafikiai.io` at a static host serving `install/install.sh` as the
  root document with `content-type: text/plain` (Cloudflare record by the owner).
  Until then the installer can be fetched from the raw repository URL.
- Add the `NPM_TOKEN` secret (an npm automation token for the `rafikicode`
  package and the `rafikicode-<os>-<arch>` platform packages). Without it the
  workflow builds and publishes the GitHub release only and runs the npm step
  in dry run mode.
- Push the first tag (`git tag v0.1.0 && git push origin v0.1.0`) and check the
  workflow output: every archive listed in `SHA256SUMS`, the release page
  showing the assets, and `curl -fsSL <installer> | bash` on a clean machine.

## Signing (TODO, issue to be opened by the owner)

The upstream project signs Windows binaries with Azure Trusted Signing and
notarizes macOS builds with an Apple developer account. Neither credential
exists for Rafiki Code yet, so this fork ships unsigned binaries verified by
SHA256SUMS only. Consequences and the plan:

- Windows: SmartScreen warns on first run. Plan: Azure Trusted Signing (or a
  standard code signing certificate) wired into a `sign-windows` job between
  build and release, following the upstream `script/sign-windows.ps1` pattern.
- macOS: Gatekeeper blocks unsigned downloads unless the user right clicks and
  opens, or removes the quarantine attribute. The installer documents the
  workaround. Plan: Apple Developer ID certificate plus notarization step.
- Linux: no OS level signing. Plan: sign `SHA256SUMS` with a project key
  (minisign or cosign) and have the installer and updater verify the signature
  when a public key is embedded in the brand module.
- Until then the installer's integrity rests on https: release overrides must
  be https URLs with a plain host (no user info), every download pins https on
  redirects too (`--proto =https --proto-redir =https`), and plain http is only
  for the literal `127.0.0.1` or `[::1]` with the explicit
  `--allow-http-loopback` test switch (`install/test-install-url.sh`). Anyone
  who controls the release page or the installer host can still ship a
  matching archive and checksum; only signing closes that.

## Later

- Homebrew tap, Scoop bucket, and AUR package: the updater already detects
  those install methods but no formula or manifest exists yet.
- Beta channel (`0.0.0-beta-<timestamp>` versions) once a `beta` branch exists.
