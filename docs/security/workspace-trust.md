# Workspace trust

Status: design note, not implemented. Rafiki Code 0.1.0 has no workspace trust system. This page says what a repository can make `rafikicode` run today, what to do about it now, and the options under review.

A *workspace* is the directory you start `rafikicode` in, up to the root of its git repository. *Workspace trust* means deciding, per workspace, whether the files inside it may make `rafikicode` run programs on your machine.

## What a repository can run today

`rafikicode` reads project configuration from the workspace: `rafikicode.json`, `rafikicode.jsonc`, `opencode.json` and `opencode.jsonc` in any directory up to the repository root, plus the `.rafikicode/` and `.opencode/` directories. Four features in that configuration start programs on your machine, with your user account, your environment variables (including `RAFIKICODE_API_KEY`) and your files (including `~/.rafikicode/credentials`):

| feature | where a repository declares it | when it runs |
|---|---|---|
| Plugins | `plugin` entries in project config (a package name or a file path), and any `.ts` or `.js` file in `.rafikicode/plugin/`, `.rafikicode/plugins/`, `.opencode/plugin/` or `.opencode/plugins/`. Custom tools in `tool/` or `tools/` in the same directories load the same way. | loaded into the `rafikicode` process at start |
| Local MCP servers | an `mcp` entry with `"type": "local"` and a `command` | started when the session starts, unless the entry sets `"enabled": false` |
| Formatters | a `formatter` entry with a `command` | after the agent edits a file with a matching extension |
| Language servers (LSP) | an `lsp` entry with a `command` | when the agent opens a file the server handles |

Agent and command Markdown files, `AGENTS.md` and other instruction files only change what the model is asked. They do not run programs by themselves; the permission settings still govern the agent's shell and edit tools. Project config can also loosen those `permission` settings.

What Rafiki Code already does: project configuration cannot move the `rafiki` provider to another address, change its headers, or hand the Rafiki key to another provider or MCP server. Those fields are removed with a warning, and any provider request that carries the key to a host other than the gateway is refused. This protects the key from configuration. It does not stop a plugin, MCP server, formatter or language server from reading the key once it runs.

## How the upstream project handles it

Upstream has no trust prompt and no per workspace approval. Project configuration and project plugin directories load whenever you start in the directory. The only switch is the environment variable `OPENCODE_DISABLE_PROJECT_CONFIG`: when it is set to `1` or `true`, the project config files and the project `.opencode/` style directories are not loaded at all (plugins, tools, MCP servers, formatters, language servers, agents, commands and project instructions from the workspace). Your user configuration in `~/.rafikicode/` still loads. The same variable works in `rafikicode`.

## What to do today

- Run `rafikicode` only in repositories whose contents you trust as much as a script you would run yourself.
- For a repository you do not trust, set `OPENCODE_DISABLE_PROJECT_CONFIG=1` before starting `rafikicode`, and read its `rafikicode.json`, `opencode.json`, `.rafikicode/` and `.opencode/` before turning it back on.
- In CI, run `rafikicode` on code that has already been reviewed, such as the base branch of a pull request. The review action in [the review recipe](../review-recipe.md) checks out the base commit for this reason. Never run it on the head of a pull request from a fork with a key available.
- Use a server key with a small budget for CI, so a leaked key has a small reach.

## Options under review

### Option A: a trust prompt per workspace

On the first start in a workspace whose project configuration declares any of the four features above, `rafikicode` lists them and asks whether to trust the workspace. The answer is stored in the user configuration, keyed by the repository's real path and a hash of the declaring files, so a change to those files asks again. An untrusted workspace loads its configuration without the four features and without permission changes. Headless runs (`rafikicode run`, `serve`, CI) treat every workspace as untrusted unless a flag or environment variable says otherwise.

- For: the behaviour people know from code editors; nothing breaks silently for trusted repositories.
- Against: the largest change to upstream code (config loading, the plugin and tool loaders, the terminal interface); prompt fatigue; the headless default changes behaviour for existing scripts.

### Option B: project features off by default, allowed from user configuration

The existing project configuration guard, which already removes key related fields, also removes project plugins and tools, local MCP server commands, formatter commands, language server commands and permission changes, with one warning line per file. A user turns features back on for named repositories in `~/.rafikicode/config.json`, for example an allow list of repository paths. Headless runs follow the same rule.

- For: small and contained; it reuses the guard the key protection already uses, so the change to upstream files is a few lines; the same behaviour in the terminal and in CI.
- Against: repositories that ship formatter or language server settings lose them until the user allows the repository; no interactive path in the first version.

### Option C: keep upstream behaviour, document it and make it visible

No change to loading. `rafikicode doctor` lists the programs the current workspace would start, the documentation (this page) states the risk, and the CI recipes set `OPENCODE_DISABLE_PROJECT_CONFIG=1` where the checkout is not needed as configuration.

- For: no change to upstream code; upstream sync stays simple.
- Against: relies on people reading; the product invites running `rafikicode` in any repository, and the key spends a prepaid wallet.

The choice is a product and security decision for the Rafiki Code owners and the security reviewer. The sandboxed builder engine is a separate question: it runs generated code inside an isolated container, and the key placed there is covered by the builder's own security review.
