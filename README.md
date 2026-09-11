# Rafiki Code CLI

`rafikicode` is the terminal coding agent of [Rafiki Code](https://code.rafikiai.io), a Rafiki Console product by PANEOTECH. It runs in your repository, reads your project's `AGENTS.md`, edits files, runs commands, and routes every model call through the Rafiki gateway so usage is metered against one Rafiki Console credit wallet.

It is a thin fork of [opencode](https://github.com/anomalyco/opencode) (MIT). See [Attribution](#attribution).

## Install

Installation channels ship with the first beta release:

```bash
# one line installer (Linux, macOS)
curl -fsSL https://get.rafikiai.io | bash

# npm
npm install -g rafikicode
```

Until then, build from source (see [Development](#development)).

## Quick start

```bash
cd your-project
rafikicode            # interactive terminal UI
rafikicode run "explain the build setup in this repo"
```

Sign in with `rafikicode login` (device flow against Rafiki Console, arriving in the next release). On servers and in CI, set a key instead:

```bash
export RAFIKICODE_API_KEY=...   # a Rafiki Console server key
rafikicode run "fix the failing test in packages/api"
```

## Models

All inference goes through the Rafiki gateway. The CLI exposes three aliases and never references provider model names:

| alias | use it for | credit cost |
|---|---|---|
| `rafiki-fast` | everyday edits and fixes (default) | lowest |
| `rafiki-pro` | long agentic tasks and larger features | higher |
| `rafiki-max` | the hardest problems | highest |

Pick one with `--model rafiki/rafiki-pro`, from the model dialog in the terminal UI, or set `"model": "rafiki/rafiki-pro"` in your config.

## Configuration

Global configuration lives at `~/.rafikicode/config.json`. Project configuration in `opencode.json` or a `.opencode/` directory at the repository root works as upstream documents it and overrides the global file.

```json
{
  "model": "rafiki/rafiki-fast",
  "instructions": ["docs/style.md"]
}
```

Useful environment variables:

| variable | purpose |
|---|---|
| `RAFIKICODE_API_KEY` | key for headless and CI use |
| `RAFIKICODE_GATEWAY_URL` | override the gateway base URL (local mocks, staging) |
| `OPENCODE_CONFIG_DIR` | use another config directory |
| `OPENCODE_*` | advanced upstream switches keep their upstream names so upstream documentation and plugins keep working |

## Project instructions

Put an `AGENTS.md` at the root of your repository (or in any subdirectory) and `rafikicode` reads it into every session. A global `~/.rafikicode/AGENTS.md` applies to all projects.

## Headless and CI

```bash
RAFIKICODE_API_KEY=... rafikicode run --format json "update the changelog for 1.4.0"
rafikicode serve --port 4096      # HTTP server for editors and automation
```

## Development

Requirements: Bun 1.3 or newer, Node 22 or newer.

```bash
bun install
cd packages/opencode
bun run src/index.ts --help           # run from source
bun test test/brand                   # brand defaults
bun run script/build.ts --single      # standalone binary in dist/
```

A local OpenAI compatible mock of the gateway for offline checks:

```bash
node packages/opencode/test/brand/mock-gateway.mjs 4180
RAFIKICODE_GATEWAY_URL=http://127.0.0.1:4180/v1 RAFIKICODE_API_KEY=stub \
  bun run packages/opencode/src/index.ts run "hello"
```

### Fork discipline

Everything Rafiki specific lives in `packages/core/src/brand/`. Upstream files import from that module through single line touchpoints and nothing else. `script/fork-diff-report.sh` lists the files that differ from `upstream/dev`; keep that list short so weekly upstream merges stay cheap.

## Attribution

Rafiki Code CLI is a fork of [opencode](https://github.com/anomalyco/opencode), copyright (c) 2025 opencode and contributors, licensed under the MIT License (see [LICENSE](./LICENSE) and [NOTICE](./NOTICE)). It is not built by, affiliated with, or endorsed by the opencode team. Upstream documentation for features that are unchanged in this fork is at [opencode.ai/docs](https://opencode.ai/docs).

## License

MIT. See [LICENSE](./LICENSE).
