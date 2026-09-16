# Rafiki Code CLI

`rafikicode` is the terminal coding agent of [Rafiki Code](https://code.rafikiai.io). Rafiki Code is part of Rafiki AI by PANEOTECH. The agent runs in your repository, reads your project's `AGENTS.md`, edits files and runs commands. Every model call it makes uses credits in your Rafiki AI account.

It is a thin fork of an open source coding agent; see [Attribution](#attribution).

## Install

One line installer for Linux and macOS (on Windows, use WSL, the Windows Subsystem for Linux):

```bash
curl -fsSL https://get.rafikiai.io | bash
```

Options, passed after `bash -s --`: `--version 0.1.4` installs a given release, `--prefix DIR` chooses another directory, `--no-modify-path` leaves your shell files alone, `--dry-run` only shows what would happen. The script is `install/install.sh` in this repository.

The installer detects your platform, downloads the release archive, verifies it against the published `SHA256SUMS` file, installs the binary into `~/.rafikicode/bin`, and adds that directory to your PATH in `~/.bashrc` for new terminals. In the terminal you installed from, run `export PATH=$HOME/.rafikicode/bin:$PATH` (or open a new terminal); `rafikicode --version` then prints `0.1.5`.

`rafikicode` is installed with the installer script. It is not published on npm.

To update:

```bash
rafikicode update            # latest release, checksum verified, binary replaced in place
```

`rafikicode update <version>` installs a specific release. `rafikicode` never updates itself unless you run this command. Release archives are verified by their SHA256 checksum; they are not code signed.

## Quick start

```bash
export PATH=$HOME/.rafikicode/bin:$PATH
rafikicode login                       # sign in with your Rafiki AI account
mkdir -p ~/calc && cd ~/calc
rafikicode run "Create a calculator web page in index.html with basic styling"
rafikicode                             # the interactive terminal interface
```

`rafikicode login` prints a code and a link. Open https://console.rafikiai.io/device, sign in with your Rafiki AI account, enter the code and approve. The terminal then stores its key in `~/.rafikicode/credentials`. `rafikicode whoami` shows the account in use, and `rafikicode logout` signs out and revokes the key.

On a server or in CI, where nobody can open a browser, use an API key instead: create a key in the Rafiki AI console at [console.rafikiai.io/keys](https://console.rafikiai.io/keys) and tick the Rafiki Code option, then:

```bash
export RAFIKICODE_API_KEY=...          # the key you created
rafikicode doctor                      # checks the key, the gateway and your tiers
rafikicode run "fix the failing test in packages/api" < /dev/null
```

Keys created without the Rafiki Code option are not billed through Rafiki Code; always tick it for keys you use with `rafikicode`. In scripts, add `< /dev/null` so `run` does not wait for input.

The full walkthrough is in [docs/quickstart.md](./docs/quickstart.md), and common messages are explained in [docs/troubleshooting.md](./docs/troubleshooting.md).

## Models

All requests go through the Rafiki AI gateway under a tier name. The CLI never uses provider model names:

| tier | use it for |
|---|---|
| `rafiki-fast` | everyday edits, fixes and questions (default) |
| `rafiki-pro` | long agentic tasks and larger features; uses more credits per token |

Pick one with `--model rafiki/rafiki-pro`, from the model dialog in the terminal interface, or set `"model": "rafiki/rafiki-pro"` in your configuration. `rafikicode models rafiki` lists the Rafiki models.

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
| `RAFIKICODE_API_KEY` | API key used by every run; takes precedence over a stored sign in |
| `RAFIKICODE_GATEWAY_URL` | override the gateway base URL (local test servers) |
| `RAFIKICODE_CONSOLE_URL` | override the Rafiki AI console base URL used by `login`, `logout` and `whoami`; https only (plain http only for 127.0.0.1, [::1] or localhost), otherwise ignored with a warning |
| `RAFIKICODE_INSTALL_DIR` | installer target directory (default `~/.rafikicode/bin`) |
| `RAFIKICODE_RELEASE_API`, `RAFIKICODE_RELEASE_BASE` | point the installer and updater at another release server (tests, mirrors) |
| `OPENCODE_CONFIG_DIR` | add another configuration directory, read as `config.json` or `rafikicode.json` there |
| `OPENCODE_*` | advanced switches keep their upstream names so upstream documentation and plugins keep working |

Every setting the CLI honors is listed in [docs/configuration.md](./docs/configuration.md).

## Project instructions

Put an `AGENTS.md` at the root of your repository (or in any subdirectory) and `rafikicode` reads it into every session. A global `~/.rafikicode/AGENTS.md` applies to all projects.

## Documentation

- [Quick start](./docs/quickstart.md): install, sign in, first task, tiers.
- [Configuration](./docs/configuration.md): files, settings, environment variables.
- [Headless and CI](./docs/headless-and-ci.md): API keys, non-interactive runs, `rafikicode doctor`, exit codes, credits running out, pipeline examples.
- [Pull request review](./docs/review-recipe.md): review a diff from the terminal, or every pull request with the bundled GitHub Action.
- [GitHub Action recipe](./docs/github-action.md): one workflow file that reviews every pull request and posts a comment.
- [MCP: n8n and Dify](./docs/mcp-rafiki-services.md): give the agent tools from your n8n workflows and Dify apps.
- [Editors](./docs/ide.md): the Rafiki Code agent in Zed and JetBrains IDEs through ACP, and settings for Cline and Aider.
- [Cline settings](./docs/ide-preset.md): Cline pointed at the Rafiki AI gateway, field by field.
- [Workspace trust](./docs/security/workspace-trust.md): what a repository may load and run, and how to trust one.
- [Troubleshooting](./docs/troubleshooting.md): messages, causes, fixes.

`rafikicode --help` lists every command.

## Development

Requirements: Bun 1.3 or newer, Node 22 or newer.

```bash
bun install
cd packages/opencode
bun run src/index.ts --help           # run from source
bun test test/brand test/rafiki       # brand defaults and the sign in commands
bun run script/build.ts --single      # standalone binary in dist/
bash install/test-install.sh          # installer against a local test release server
node docs/check.mjs                   # documentation links, fences, wording
```

`bun install` needs `make` for one optional native module; on a machine without a compiler use `bun install --ignore-scripts` (the module has a WebAssembly fallback).

### Releases

Pushing a tag `v<version>` runs `.github/workflows/release.yml`: every platform binary is built on one Linux runner, archived as `rafikicode-<os>-<arch>.tar.gz` (Linux) or `.zip` (macOS, Windows), listed in `SHA256SUMS`, and attached to the GitHub release.

Local test servers for offline checks, both in `packages/opencode/test/brand/`: `mock-gateway.mjs` (an OpenAI compatible endpoint) and `mock-console.mjs` (the sign in flow):

```bash
node packages/opencode/test/brand/mock-gateway.mjs 4180
RAFIKICODE_GATEWAY_URL=http://127.0.0.1:4180/v1 RAFIKICODE_API_KEY=stub \
  bun run packages/opencode/src/index.ts run "hello" < /dev/null
```

### Fork discipline

Everything Rafiki specific lives in `packages/core/src/brand/` and `packages/opencode/src/rafiki/`. Upstream files import from those modules through single line touchpoints and nothing else. `script/fork-diff-report.sh` lists the files that differ from `upstream/dev`; keep that list short so upstream merges stay cheap.

## Attribution

Rafiki Code CLI is a fork of [opencode](https://github.com/anomalyco/opencode), copyright (c) 2025 opencode and contributors, licensed under the MIT License (see [LICENSE](./LICENSE) and [NOTICE](./NOTICE)). It is not built by, affiliated with, or endorsed by the opencode team. Upstream documentation for features that are unchanged in this fork is at [opencode.ai/docs](https://opencode.ai/docs).

## License

MIT. See [LICENSE](./LICENSE).
