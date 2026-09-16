# Releasing Rafiki Code for VS Code

A checklist for packaging and publishing the extension in `sdks/vscode`. Nothing here runs automatically: CI builds the `.vsix` (the extension package file) on a tag, and a person publishes it. Secrets are named here, never shown; keep their values in a password manager and in GitHub secrets only.

Registries:

- **Visual Studio Marketplace**: the store built into Microsoft VS Code. Its terms allow use from Microsoft products only.
- **Open VSX**: the open registry run by the Eclipse Foundation, used by VSCodium and several other editors built on VS Code. Publishing there is how those editors get the extension.

## 1. Decisions before the first release

- [ ] **Publisher ID.** `package.json` uses the placeholder `paneotech`. The Marketplace publisher ID and the Open VSX namespace must both equal it, and it cannot be renamed later (a new ID means a new extension for every user). Decide the final value, then update `publisher` in `sdks/vscode/package.json` and the identifier in `docs/vscode.md` and in the integration test (`EXTENSION_ID`).
- [ ] **Extension name** `rafiki-code` and display name `Rafiki Code`. The full identifier is `<publisher>.rafiki-code`.
- [ ] **Go ahead for D2** (memo `ide-and-console-lock-v1.md`: planned for v1.1).
- [ ] **Minimum CLI**: references need `rafikicode` 0.1.2 or later, so publish after 0.1.2 is released on get.rafikiai.io.
- [ ] **Repository link**: `package.json` points to `github.com/paneotech-dev/rafiki-code-cli`, and the README links to `docs/vscode.md` on its `main` branch. Confirm that repository is public and that the page is on `main` before publishing, or the listing shows broken links.
- [ ] **Listing content**: `sdks/vscode/README.md` is the listing page. Consider adding one screenshot (hosted on an https URL; the Marketplace refuses SVG images from other hosts).
- [ ] **Icon**: `images/icon.png` is the Rafiki mark (256 by 256, from the Console brand set). Replace it if brand wants a different one; it must be a PNG of at least 128 by 128.

## 2. Microsoft Visual Studio Marketplace (one time)

- [ ] Sign in at `https://marketplace.visualstudio.com/manage` with the Microsoft account PANEOTECH will own the listing with (a shared company account, not a personal one).
- [ ] Create the publisher with the chosen ID and name "PANEOTECH". Add a second owner so the listing is never tied to one person.
- [ ] Create an Azure DevOps organization for the same account if you do not have one (`https://dev.azure.com`). The publishing token is created there.
- [ ] Create a Personal Access Token in Azure DevOps: organization "All accessible organizations", scope **Marketplace: Manage**, the shortest expiry you are willing to renew. Store it as **`VSCE_PAT`**.
- [ ] Optional: verified publisher. Microsoft offers a verified badge after DNS verification of a domain (for example `rafikiai.io`); check Microsoft's current eligibility rules on the publisher page.
- [ ] Check that the account can publish: from `sdks/vscode`, with `VSCE_PAT` in the environment, `./node_modules/.bin/vsce verify-pat <publisher>`.

## 3. Open VSX (one time)

- [ ] Create an Eclipse Foundation account and sign the **Open VSX Publisher Agreement** (required before any publish).
- [ ] Log in at `https://open-vsx.org` with GitHub (use the PANEOTECH organization owner's account), link the Eclipse account in the profile settings.
- [ ] Create an access token under the profile's **Access Tokens**. Store it as **`OVSX_PAT`**.
- [ ] Create the namespace with the same ID as the Marketplace publisher: from `sdks/vscode`, `./node_modules/.bin/ovsx create-namespace <publisher>` (it reads `OVSX_PAT` from the environment).
- [ ] Ask for namespace ownership (verified namespace) by opening an issue in the `EclipseFdn/open-vsx.org` repository on GitHub, as their publishing guide describes. Until then the listing shows a warning.

## 4. Signing

- [ ] No signing key is needed in this repository today. The Marketplace signs every published extension on its side, and VS Code checks that signature on install. Open VSX also signs published extensions with its own key. Confirm both on the first publish (the Marketplace listing and `vsce`'s output say so) and record the result here.
- [ ] Each CI build publishes a SHA256 checksum next to the `.vsix`. When a `.vsix` is shared outside the marketplaces (for example before the listing exists), share the checksum through a separate channel and ask testers to check it (`sha256sum rafiki-code-<version>.vsix`).
- [ ] Code signing of the CLI binaries is tracked separately in `docs/RELEASE_TODO.md`.

## 5. Every release

1. [ ] On a branch: bump `version` in `sdks/vscode/package.json`, add the entry to `sdks/vscode/CHANGELOG.md`, update the `.vsix` file name in `docs/vscode.md` if it is mentioned.
2. [ ] Checks from `sdks/vscode` (all pinned tools, nothing global):

   ```bash
   bun install --frozen-lockfile --ignore-scripts
   bun run check-types && bun run lint && bun run test:unit
   xvfb-run -a bun run test
   bun run vsix
   ./node_modules/.bin/vsce ls --no-dependencies
   ```

   The file list must be exactly: `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `NOTICE`, `dist/extension.js`, and the three files in `images/`.
3. [ ] Merge the branch after review.
4. [ ] Tag from an up to date `main`, from `sdks/vscode`: `script/release`. It creates `rafiki-vscode-v<version>` and pushes that one tag only. The tag prefix keeps it apart from the CLI's `v*` tags and from upstream tags.
5. [ ] The `rafiki-vscode` workflow (`.github/workflows/rafiki-vscode.yml`) checks the tag against `package.json`, runs the checks and the tests inside VS Code, and uploads `rafiki-code-<version>.vsix` and its `.sha256` as the `rafiki-code-vsix` artifact. It publishes nothing.
6. [ ] Download the artifact, check the checksum, install it in a clean VS Code profile (`code --profile rafiki-test --install-extension rafiki-code-<version>.vsix`), sign in, open a session, send a file, run Doctor.
7. [ ] Publish the same file to both registries, from `sdks/vscode` after `bun install`, with `VSCE_PAT` and `OVSX_PAT` in the environment (for example loaded from the password manager for that shell only, never typed into a command line that lands in history):

   ```bash
   script/publish path/to/rafiki-code-<version>.vsix
   ```

8. [ ] Check both listings: version, icon, README, links. Install from each registry once (VS Code, and VSCodium for Open VSX).
9. [ ] Attach the `.vsix` and its checksum to a GitHub release if you want a download link, and update the install section of `docs/vscode.md` once the listings are live.

## 6. If publishing moves into CI later

- [ ] Add a GitHub environment (for example `vscode-publish`) with a required reviewer, and put `VSCE_PAT` and `OVSX_PAT` in that environment only.
- [ ] Add a job to `rafiki-vscode.yml` that needs the build job, uses that environment, downloads the artifact and runs the two publish commands. Never print the tokens, and pass them only through `env`.
- [ ] Rotate both tokens on a calendar reminder before they expire, and revoke them at once if a runner or a maintainer account is compromised.

## 7. Notes

- The upstream publish workflow (`.github/workflows/publish-vscode.yml`) is kept in the fork but only runs in the upstream repository, so an upstream `vscode-v*` tag reaching this repository publishes nothing.
- The extension collects no telemetry and sends nothing itself: every network call is made by `rafikicode`.
- Removing a listing: `vsce unpublish <publisher>.rafiki-code` on the Marketplace; on Open VSX, ask through their support. Users keep installed copies either way.
