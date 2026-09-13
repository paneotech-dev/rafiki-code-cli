# Workspace trust

Status: implemented in release candidate 4 as an interim default, pending the product decision by the Rafiki Code owners and the security reviewer (see [Decision still open](#decision-still-open)).

A *workspace* is the directory you start `rafikicode` in, up to the root of its git repository. *Workspace trust* means deciding, per workspace, whether the files inside it may make `rafikicode` run programs on your machine or read your secrets.

## What a repository can declare

`rafikicode` reads project configuration from the workspace: `rafikicode.json`, `rafikicode.jsonc`, `opencode.json` and `opencode.jsonc` in any directory up to the repository root, plus the `.rafikicode/` and `.opencode/` directories. These features start programs on your machine, with your user account, your environment variables (including `RAFIKICODE_API_KEY`) and your files (including `~/.rafikicode/credentials`):

| feature | where a repository declares it | when it runs |
|---|---|---|
| Plugins | `plugin` entries in project config (a package name or a file path), and any `.ts` or `.js` file in `.rafikicode/plugin/`, `.rafikicode/plugins/`, `.opencode/plugin/` or `.opencode/plugins/`; `plugin` entries in a project `tui.json` | loaded into the `rafikicode` process at start |
| Custom tools | `.ts` or `.js` files in `tool/` or `tools/` of the same directories | loaded at start |
| Provider packages | a provider's `npm` field (a package name or a `file://` path) in project config | imported when a model of that provider is used, including `small_model` and agent models |
| Local MCP servers | an `mcp` entry with `"type": "local"` and a `command` | started when the session starts, unless the entry sets `"enabled": false` |
| Formatters | a `formatter` entry with a `command` | after the agent edits a file with a matching extension |
| Language servers (LSP) | an `lsp` entry with a `command` | when the agent opens a file the server handles |
| Shell permission | `permission`, `agent.<name>.permission` or an agent Markdown file allowing `bash` | when the model asks to run a command |
| Substitution | `{env:NAME}` and `{file:path}` anywhere in project config, including `tui.json` | when the config loads; the value can be sent to any URL the config names (a remote MCP server, an instructions URL, another provider) |
| Spend | a `rafiki` model's `id`, `options`, `variants` or `limit`, and any agent or mode `options` field other than `temperature`, `top_p`, `top_k`, `reasoningEffort`, `textVerbosity`, `timeout`, `chunkTimeout` and `headerTimeout` (compared without case, `_` or `-`), whether or not the file also configures a provider | on every request: agent and mode options are merged into the request body, so a tier can call another model or raise its output limit while its name stays the same |

## What rafikicode does (release candidate 4)

A workspace is **trusted** when you said so:

- `rafikicode trust` (in the workspace, or `rafikicode trust <dir>`) stores the directory's real path in `~/.rafikicode/trusted-workspaces.json` (mode 0600). Everything at or under it is trusted. `rafikicode trust --list` shows the list and `rafikicode trust --remove [dir]` takes it back. The file system root cannot be trusted.
- `RAFIKICODE_TRUST_WORKSPACE=1` trusts the workspace of that one run, for CI jobs that need their repository's plugins. It also accepts a list of absolute directories separated by `:` (`;` on Windows).

The store is ignored when it is a symbolic link, belongs to another user, or can be written by others.

| | untrusted, at a terminal | untrusted, headless | trusted |
|---|---|---|---|
| Plugins, custom tools, TUI plugins | not loaded, one warning line | not loaded, one warning line | loaded |
| Provider packages | only `@ai-sdk/*` packages | only `@ai-sdk/*` packages | any |
| Local MCP servers, formatters, language servers | loaded (upstream behaviour) | removed, one warning line | loaded |
| Permission settings that allow the shell | kept | removed, one warning line | kept |
| `{env:}` of secret names, `{file:}` outside the project, in any project config file (`rafikicode.json`, `opencode.json`, `tui.json`, their `jsonc` forms, the same files in `.rafikicode/` and `.opencode/`) | replaced by an empty value, one warning line per reference | same | full substitution |
| `rafiki` model `id`, `options`, `variants`, `limit`; request fields in agent and mode `options` (config files and agent Markdown files) | removed, one warning line | same | kept |
| `rafiki` provider base URL, headers, key source | removed, one warning line | same | kept, but the key still only goes to the gateway (below) |
| Agents, commands, skills, instructions | loaded | loaded | loaded |

*Headless* means nobody can answer a question: `CI` is set (and not `0` or `false`), `GITHUB_ACTIONS=true`, or `rafikicode run` without a terminal on standard input or output. In headless runs the shell tool (`bash`) defaults to *ask*, and `rafikicode run` rejects a question nobody can answer, so a command runs only when something you control allows it: `permission` in `~/.rafikicode/config.json`, `OPENCODE_PERMISSION`, `rafikicode run --auto`, or a trusted workspace. See [Headless and CI](../headless-and-ci.md#shell-commands-in-headless-runs).

*Secret names* are environment variable names containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL` or `PRIVATE` (any case), and `RAFIKICODE_API_KEY`. *The project* is the git repository root, or the working directory outside git; a `{file:}` path is resolved through symbolic links before the check.

Your own configuration keeps full behaviour: `~/.rafikicode/` (or `$XDG_CONFIG_HOME/rafikicode/`), the directory named by `OPENCODE_CONFIG_DIR`, and the files named by `OPENCODE_CONFIG` and `OPENCODE_CONFIG_CONTENT`. Other directories under your home, such as `~/.opencode/`, are treated like project directories. When the home directory itself is a git checkout (some CI images set `HOME` to the checkout), `~/.rafikicode/` came with the repository and is treated like project configuration too, including substitution in its `config.json`, `opencode.json` and `tui.json`; use `XDG_CONFIG_HOME` or `OPENCODE_CONFIG_DIR` to point at a real user configuration in that case.

The background dependency install that prepares plugin directories runs only for directories whose code may load (your own configuration and trusted workspaces).

The key has one more guard that trust does not relax: any provider request that carries the Rafiki key to a host other than the gateway (the built in one, `RAFIKICODE_GATEWAY_URL`, the URL the Console returned at login, or a base URL in your own configuration) is refused.

`OPENCODE_DISABLE_PROJECT_CONFIG=1` (alias `RAFIKICODE_DISABLE_PROJECT_CONFIG=1`) still loads nothing at all from the working tree, trusted or not.

## What stays open

- A trusted workspace can run code, and code can read the key from the environment or the credential file. Trust only repositories whose contents you would run as a script.
- At a terminal, an untrusted workspace still starts its local MCP servers, formatters and language servers, as upstream does. Only headless runs remove them.
- The key guard reads string, byte and form request bodies; a streamed body is not inspected (provider packages send JSON strings).
- A home directory that is an unpacked archive rather than a git checkout is not detected as part of the repository.
- There is no interactive trust prompt in the terminal interface yet; the warning line names the `rafikicode trust` command.

## What to do

- For a repository you do not trust, run `rafikicode` without trusting it, or set `RAFIKICODE_DISABLE_PROJECT_CONFIG=1` to ignore its configuration entirely.
- In CI, run `rafikicode` on code that has already been reviewed, such as the base branch of a pull request. The review action in [the review recipe](../review-recipe.md) checks out the base commit for this reason and denies edits, shell commands and web fetches. Never run it on the head of a pull request from a fork with a key available.
- Use a server key with a small budget for CI, so a leaked key has a small reach.

## Decision still open

The shipped behaviour is controlled by one value in the Rafiki layer, `PROJECT_CODE` in `packages/core/src/brand/trust.ts`:

- `"trusted"` (shipped): project plugins, custom tools, TUI plugins and provider packages load only from trusted workspaces, at a terminal and in headless runs.
- `"interactive"`: upstream loading for a person at a terminal; headless runs still load project code only from trusted workspaces.

The options that were under review:

- **Option A, a trust prompt per workspace.** Release candidate 4 implements this option without the prompt itself: the decision is stored per workspace with `rafikicode trust`, headless runs treat every workspace as untrusted unless trusted by the store or `RAFIKICODE_TRUST_WORKSPACE`, and untrusted headless runs lose the program starting features and shell permissions. A prompt in the terminal interface, and a hash of the declaring files so a change asks again, are not built.
- **Option B, project features off by default, allowed from user configuration.** Close to the headless column above; release candidate 4 does not remove MCP servers, formatters and language servers at a terminal.
- **Option C, keep upstream behaviour and document it.** Available by setting `PROJECT_CODE` to `"interactive"` for the terminal part only.

Questions for the owners and the security reviewer: keep `"trusted"` as the default; also remove local MCP servers, formatters and language servers at a terminal for untrusted workspaces; add the interactive prompt and the file hash; whether `rafikicode serve` should also refuse to start on `127.0.0.1` without a password (release candidate 5 refuses every other address and warns on loopback).

The sandboxed builder engine is a separate question: it runs generated code inside an isolated container, and the key placed there is covered by the builder's own security review.
