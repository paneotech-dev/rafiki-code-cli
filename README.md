# Rafiki Code CLI

`rafikicode` is the terminal coding agent of [Rafiki Code](https://code.rafikiai.io), a Rafiki Console product by PANEOTECH for developers. It runs in your repository, reads your project's `AGENTS.md`, edits files, runs commands, and routes every model call through the Rafiki gateway, so usage is metered against one Rafiki Console credit wallet shared with the web builder and your editor.

It is a thin fork of an open source coding agent; see [Attribution](#attribution).

## Install

One line installer for Linux and macOS (Windows through WSL for now):

```bash
curl -fsSL https://get.rafikiai.io | bash
```

The installer detects your platform, downloads the release archive, verifies it against the published `SHA256SUMS`, installs the binary into `~/.rafikicode/bin`, and prints the PATH line for your shell. Options: `--version 1.2.3` pins a release, `--prefix DIR` chooses another directory, `--no-modify-path` leaves your shell files alone, `--dry-run` only shows what would happen. The script is `install/install.sh` in this repository.

npm as a second channel:

```bash
npm install -g rafikicode
```

Keeping it current:

```bash
rafikicode update            # latest release, checksum verified, binary swapped in place
rafikicode update 1.2.3      # a specific version
```

Automatic update checks are off by default. Installation channels go live with the first tagged release; until then, build from source (see [Development](#development)). Release archives are unsigned in this phase and verified by checksum only, see `docs/RELEASE_TODO.md`.

## Quick start

```bash
rafikicode login                       # prints a code, approve it at console.rafikiai.io/device
cd your-project
rafikicode run "explain the build setup in this repo"
rafikicode                             # the interactive terminal UI
```

`login` gives this terminal its own gateway key with a budget you can see and revoke in Rafiki Console; the key is stored in `~/.rafikicode/credentials`, readable by your user only. `whoami` shows the account, key budget and wallet balance; `logout` revokes the key; `doctor` checks the whole setup, one line per check. On servers and in CI there is no browser, so set a server key instead:

```bash
export RAFIKICODE_API_KEY=...   # created at console.rafikiai.io/keys
rafikicode run "fix the failing test in packages/api" < /dev/null
```

The full walkthrough is in [docs/quickstart.md](./docs/quickstart.md).

## Models

All inference goes through the Rafiki gateway under three aliases. Credits are charged per token with a multiplier per tier, and the CLI never references provider model names:

| alias | multiplier | use it for |
|---|---|---|
| `rafiki-fast` | 1x | everyday edits and fixes (default) |
| `rafiki-pro` | 4x | long agentic tasks and larger features |
| `rafiki-max` | 15x | the hardest problems |

Pick one with `--model rafiki/rafiki-pro`, from the model dialog in the terminal UI, or set `"model": "rafiki/rafiki-pro"` in your config. `rafikicode models rafiki` lists the aliases your key can use.

## Configuration

Global configuration lives at `~/.rafikicode/config.json`. Project configuration in `rafikicode.json` or a `.rafikicode/` directory at the repository root overrides the global file.

```json
{
  "model": "rafiki/rafiki-fast",
  "instructions": ["docs/style.md"]
}
```

Environment variables:

| variable | purpose |
|---|---|
| `RAFIKICODE_API_KEY` | server key for headless and CI use, takes precedence over the stored login |
| `RAFIKICODE_GATEWAY_URL` | override the gateway base URL (local mocks, staging) |
| `RAFIKICODE_CONSOLE_URL` | override the Console base URL used by login, logout and whoami |
| `RAFIKICODE_INSTALL_DIR` | installer target directory (default `~/.rafikicode/bin`) |
| `RAFIKICODE_RELEASE_API`, `RAFIKICODE_RELEASE_BASE` | point the installer and updater at another release server (tests, mirrors) |
| `OPENCODE_CONFIG_DIR` | add another config directory, read as `config.json` or `rafikicode.json` there |
| `OPENCODE_*` | advanced upstream switches keep their upstream names so upstream documentation and plugins keep working |

Every key the CLI honors is listed in [docs/configuration.md](./docs/configuration.md).

## Project instructions

Put an `AGENTS.md` at the root of your repository (or in any subdirectory) and `rafikicode` reads it into every session. A global `~/.rafikicode/AGENTS.md` applies to all projects.

## Documentation

- [Quick start](./docs/quickstart.md): install, sign in, first task, tiers.
- [Configuration](./docs/configuration.md): files, keys, environment variables.
- [Headless and CI](./docs/headless-and-ci.md): server keys, non-interactive runs, `rafikicode doctor`, exit codes, budget exhaustion, pipeline examples.
- [Pull request review](./docs/review-recipe.md): review a diff from the terminal, or every pull request with the bundled GitHub Action.
- [MCP: n8n and Dify](./docs/mcp-rafiki-services.md): give the agent tools from your n8n workflows and Dify apps.
- [IDE preset](./docs/ide-preset.md): Cline pointed at the gateway with a Rafiki key.
- [Troubleshooting](./docs/troubleshooting.md): messages, causes, fixes.

`rafikicode serve --port 4096` starts the HTTP server for editors and automation; `rafikicode --help` lists every command.

## Development

Requirements: Bun 1.3 or newer, Node 22 or newer.

```bash
bun install
cd packages/opencode
bun run src/index.ts --help           # run from source
bun test test/brand test/rafiki       # brand defaults and the sign-in commands
bun run script/build.ts --single      # standalone binary in dist/
bash install/test-install.sh          # installer against a local mock release server
node docs/check.mjs                   # documentation links, fences, wording
```

`bun install` needs `make` for one optional native module; on a machine without a compiler use `bun install --ignore-scripts` (the module has a WebAssembly fallback).

### Releases

Pushing a tag `v<version>` runs `.github/workflows/release.yml`: every platform binary is built on one Linux runner, archived as `rafikicode-<os>-<arch>.tar.gz` (Linux) or `.zip` (macOS, Windows), listed in `SHA256SUMS`, and attached to the GitHub release. The npm packages (`rafikicode` plus one `rafikicode-<os>-<arch>` package per binary) are published by `packages/opencode/script/publish-npm.ts` when an `NPM_TOKEN` secret exists. Open items, including binary signing, are tracked in `docs/RELEASE_TODO.md`.

Local mocks for offline checks, both in `packages/opencode/test/brand/`: `mock-gateway.mjs` (an OpenAI compatible endpoint) and `mock-console.mjs` (the sign-in flow):

```bash
node packages/opencode/test/brand/mock-gateway.mjs 4180
RAFIKICODE_GATEWAY_URL=http://127.0.0.1:4180/v1 RAFIKICODE_API_KEY=stub \
  bun run packages/opencode/src/index.ts run "hello" < /dev/null
```

### Fork discipline

Everything Rafiki specific lives in `packages/core/src/brand/` and `packages/opencode/src/rafiki/`. Upstream files import from those modules through single line touchpoints and nothing else. `script/fork-diff-report.sh` lists the files that differ from `upstream/dev`; keep that list short so weekly upstream merges stay cheap.

## Attribution

Rafiki Code CLI is a fork of [opencode](https://github.com/anomalyco/opencode), copyright (c) 2025 opencode and contributors, licensed under the MIT License (see [LICENSE](./LICENSE) and [NOTICE](./NOTICE)). It is not built by, affiliated with, or endorsed by the opencode team. Upstream documentation for features that are unchanged in this fork is at [opencode.ai/docs](https://opencode.ai/docs).

## License

MIT. See [LICENSE](./LICENSE).
