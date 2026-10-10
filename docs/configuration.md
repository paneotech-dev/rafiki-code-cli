# Configuration

`rafikicode` reads configuration from a global file, an optional project file, and a few environment variables. Later sources override earlier ones: built-in defaults, then the global file, then the project file, then environment variables and command line flags.

## Files

| location | purpose |
|---|---|
| `~/.rafikicode/config.json` | global settings for your user. Created on first run with the built-in defaults |
| `~/.rafikicode/AGENTS.md` | instructions applied to every project |
| `~/.rafikicode/credentials` | the key stored by `rafikicode login`, mode 0600, in a directory `login` sets to 0700. The file is not used (exit 2, with the fix to run) when it is a symbolic link, belongs to another user, can be read or written by others, or sits in a directory other users can write. Do not edit by hand; `logout` removes it |
| `rafikicode.json` or `rafikicode.jsonc` at the repository root, or a `.rafikicode/` directory | project settings, committed with the project so the whole team shares them |
| `AGENTS.md` in the repository (root or a subdirectory) | project instructions, read into every session |

The file is JSON; JSONC (JSON with comments) is accepted for the `.jsonc` name. A minimal global file:

```json
{
  "model": "rafiki/rafiki-fast",
  "instructions": ["docs/conventions.md"]
}
```

The environment variable `OPENCODE_CONFIG_DIR` adds another configuration directory (useful for isolated test environments and mocks). The CLI reads `config.json`, `rafikicode.json`, or `rafikicode.jsonc` in that directory; the global `~/.rafikicode/config.json` is still read first. `XDG_CONFIG_HOME`, when set, moves the `~/.rafikicode` directory the same way as on any other XDG aware tool.

## Built-in defaults

Two defaults are seeded by the product and can be overridden in the global file:

- `autoupdate` is `true`. Once a day at most, the interactive interface looks for a new release, downloads it in the background, verifies it against the published `SHA256SUMS`, and the next start uses it. `"notify"` checks and asks before doing anything; `false` turns the check off, and then the CLI replaces itself only when you run `rafikicode update`. The environment variable `RAFIKICODE_DISABLE_AUTOUPDATE=1` turns it off for one process. See [Install and update](./install.md#updates).
- The `rafiki` provider is registered automatically once a credential exists (a stored sign in or `RAFIKICODE_API_KEY`), pointing at the Rafiki AI gateway with the Rafiki tiers (`rafiki-fast`, `rafiki-pro`, `rafiki-max`). Without a credential no provider is registered and the CLI tells you to sign in.
- `rafikicode` offers the Rafiki tiers only. Keys for other providers in the environment are not used. `enabled_providers`, and a `model`, `small_model`, `agent.<name>.model` or `mode.<name>.model` naming another provider, are ignored with one warning line each; `provider` entries for other providers are loaded but never offered. `--model` naming another provider stops `run` and the terminal interface with exit code 2.

## Keys

Every top-level key the CLI honors, with the meaning from the configuration schema. Keys not listed here are ignored.

| key | meaning |
|---|---|
| `$schema` | JSON schema reference for editor validation, optional |
| `model` | default model in `provider/model` form, for example `rafiki/rafiki-pro` |
| `default_agent` | default primary agent when a session does not pick one |
| `autoupdate` | `true`, `false` or `"notify"`, see above |
| `share` | `"manual"`, `"auto"` or `"disabled"`: whether sessions may be shared through the share service |
| `shell` | default shell for the terminal and the shell tool |
| `username` | name displayed in conversations |
| `instructions` | additional file paths or URLs whose content is added as instructions to every session |
| `permission` | ordered rules deciding which tool actions run without asking, ask, or are denied, for example `{"permission": {"bash": "allow", "edit": "allow"}}` |
| `permission.publish` | commands that publish code (`git push`, `gh pr create`, `gh repo create`, `gh release`) always ask in the interface. `"deny"` refuses them without a question; `"allow"` lets `rafikicode run` push. See [Pushes ask first](./github.md#pushes-ask-first) |
| `agent` | overrides of built-in agents and custom agent definitions |
| `command` | named slash commands |
| `skills` | additional paths or URLs to discover skills from |
| `references` | named local directories or Git repositories available as external context |
| `plugin` | ordered external plugin packages to load |
| `mcp` | Model Context Protocol server configuration (external tool servers the agent can call) |
| `lsp` | enable built-in language servers or configure overrides |
| `formatter` | enable built-in formatters or configure overrides |
| `watcher` | filesystem watcher settings |
| `snapshot` | enable snapshots used for undo and revert |
| `compaction` | conversation compaction behavior for long sessions. `compaction.prune` (`true` or `false`) turns the replacement of old tool output on or off, see [Long sessions: old tool output](#long-sessions-old-tool-output) |
| `attachment` | attachment processing settings |
| `tool_output` | truncation thresholds for tool output |
| `provider` | provider definitions. The `rafiki` entry is seeded for you; its `whitelist`, `blacklist` and model settings apply |
| `enterprise` | enterprise sharing service settings |
| `experimental` | switches that may change between releases |

The structure of the nested keys (`permission`, `agent`, `mcp`, and so on) is unchanged from the upstream project; the upstream documentation for those sections applies as written.

## Environment variables

| variable | purpose |
|---|---|
| `RAFIKICODE_API_KEY` | API key for headless and CI use, created in the Rafiki AI console with the Rafiki Code option ticked. Takes precedence over the stored sign in |
| `RAFIKICODE_GATEWAY_URL` | override the gateway base URL (local test servers). Default `https://gateway.rafikiai.io/v1`. Must be https; plain http is accepted only for `127.0.0.1`, `[::1]` or `localhost`. Any other value is not used, a warning is printed and the key is not sent there. The same rule applies to the gateway URL the console returns at sign in and to a `baseURL` in your own configuration |
| `RAFIKICODE_CACHE_MARKERS` | which tiers carry a prompt cache marker (a field that tells the model provider where the repeated start of a request ends, so it can reuse it at a lower price): `all`, `off`, or tier names separated by commas. Unset, the CLI marks the tiers that need one. Every request starts with the same text in the same order on every tier either way; today's date is sent after that text, in a message of its own |
| `RAFIKICODE_ALLOW_PUSH` | `1` lets `rafikicode run` publish code (`git push`, `gh pr create`, `gh repo create`, `gh release`), like `run --allow-push`. Without it a run refuses them. See [Pushing code from a run](./headless-and-ci.md#pushing-code-from-a-run) |
| `RAFIKICODE_PRUNE` | `0`, `off` or `false` stops replacing old tool output; `1`, `on` or `true` turns it on, on any provider. Wins over `compaction.prune`. Unset, it is on for the Rafiki tiers. See [Long sessions: old tool output](#long-sessions-old-tool-output) |
| `RAFIKICODE_CONSOLE_URL` | override the Rafiki AI console base URL used by `login`, `logout`, `whoami` and `doctor`. Default `https://console.rafikiai.io`. The key is sent there, so only an https URL is used (plain http only for 127.0.0.1, [::1] or localhost); any other value is ignored with a warning, and so is a console URL on plain http elsewhere returned at sign in |
| `RAFIKICODE_INSTALL_DIR` | installer target directory. Default `~/.rafikicode/bin` |
| `RAFIKICODE_RELEASE_API`, `RAFIKICODE_RELEASE_BASE` | point the installer and `rafikicode update` at another release server (mirrors, tests). Must be https. The installer accepts plain http only for `127.0.0.1` or `[::1]` together with `--allow-http-loopback` or `RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK=1` (local tests); `rafikicode update` follows the same rule with `RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK=1`, and follows a redirect only to a URL that passes it |
| `RAFIKICODE_TRUST_WORKSPACE` | `1` or `true` trusts the workspace of this run, or a list of directories separated by `:`: its project plugins, custom tools, provider packages and settings load. `rafikicode trust` stores the same decision. See [workspace trust](security/workspace-trust.md) |
| `RAFIKICODE_REASONING_EFFORT` | reasoning effort sent on every tier: `none`, `low`, `medium`, `high`, or `default` for no parameter. See [Reasoning and output limits](#reasoning-and-output-limits) |
| `RAFIKICODE_MAX_OUTPUT_TOKENS` | output token limit for every tier, from 1024 to the most the model behind the tier can write (384000 on `rafiki-fast`, 128000 on `rafiki-pro` and `rafiki-max`). A value above a tier's maximum is ignored for that tier |
| `RAFIKICODE_RETRY_WINDOW` | how long, in seconds, a task keeps retrying when the connection to the gateway is lost after the gateway has answered at least once. Default `120`. Retries back off from 2 seconds to 30 seconds with a random part added to each wait. `0` goes back to a single retry. See [When the connection drops](troubleshooting.md#when-the-connection-drops) |
| `RAFIKICODE_DISABLE_PROJECT_CONFIG` | set to `1` or `true` to load nothing from the working tree: no project config files, plugins, tools, skills, MCP servers, formatters or language servers. Alias of `OPENCODE_DISABLE_PROJECT_CONFIG`. See [workspace trust](security/workspace-trust.md) |
| `OPENCODE_CONFIG_DIR` | add another configuration directory, read as `config.json`, `rafikicode.json`, or `rafikicode.jsonc` there |
| `RAFIKICODE_SERVER_PASSWORD`, `RAFIKICODE_SERVER_USERNAME` | basic authentication (a user name and password sent with every request) for the local server of `rafikicode serve` and `web`, and the password `rafikicode attach` and `run --attach` send. The user name is `rafikicode` unless you set `RAFIKICODE_SERVER_USERNAME`; for example `curl -u rafikicode:<password> http://127.0.0.1:4096/doc`. The upstream names `OPENCODE_SERVER_PASSWORD` and `OPENCODE_SERVER_USERNAME` still work when the `RAFIKICODE_` one is not set. The server can run commands and read files as you, so without a password it listens only on this machine: `--hostname` with another address, or `--mdns`, is refused with exit code 2. When neither variable is set, `serve` and `web` on `127.0.0.1` make a random password for that server and store it in a server file (see below); `rafikicode acp` makes one for its own process only. A password you set is used as before, and no server file is written |
| `OPENCODE_*` | other advanced switches keep their upstream names so upstream documentation and plugins keep working |

### Server files

When `rafikicode serve` or `rafikicode web` starts on `127.0.0.1`, `::1` or `localhost` and neither `RAFIKICODE_SERVER_PASSWORD` nor `OPENCODE_SERVER_PASSWORD` is set, it makes a random 32 byte password for that server. It stores the password in `~/.rafikicode/servers/<port>.json` (`$XDG_CONFIG_HOME/rafikicode/servers/` when `XDG_CONFIG_HOME` is set) and prints one line naming the file, never the password:

```text
Server password: stored in /home/you/.rafikicode/servers/4096.json (user name rafikicode). rafikicode attach and run --attach on this machine read it from there; other programs must send it. Set RAFIKICODE_SERVER_PASSWORD to choose your own.
```

- The `servers` directory is created with mode 0700 and each file with mode 0600, written through a temporary file and a rename. The file holds the port, the server's process ID (PID), the user name and the password.
- The file is removed when the server exits (Ctrl-c, `SIGTERM` or `SIGHUP`). A server stopped with `kill -9` leaves it behind. The next `attach` to that port finds that the process is gone, ignores the file and removes it.
- `rafikicode attach <url>` and `rafikicode run --attach <url>` read the file when the URL is a loopback address, no password is given (`--password` or the variables above), and the port matches. The file is used only when the file and the `servers` directory belong to you and no other user can read them, and the PID in it is a running process of yours. Otherwise the client prints `Warning: not using the server file ...` with the reason, and sends no password.
- The password is removed from the server's own environment once it listens, so shells, tools and MCP servers it starts do not inherit it.
- Other programs, such as `curl` or your own scripts, must send the password, for example with `jq`: `curl -u "rafikicode:$(jq -r .password ~/.rafikicode/servers/4096.json)" http://127.0.0.1:4096/doc`.
- `rafikicode web` opens the browser at the plain address, without the password in the command line (other users can read a command line). The browser asks for a user name and password: enter `rafikicode` and the `password` value from the file. To avoid the prompt, set `RAFIKICODE_SERVER_PASSWORD` yourself.
- Before this change, `serve` and `web` on `127.0.0.1` ran with no password and printed a warning, and any program or user on the machine could read your files and run commands through them. Scripts that called such a server without a password now get 401: set `RAFIKICODE_SERVER_PASSWORD` for the server and the script, or read the server file.
- If the directory cannot be used safely (a symbolic link, owned by another user, or a parent directory other users can write), the server does not start: it prints the reason and exits with code 2.

## Reasoning and output limits

Every tier is a *reasoning model*: it thinks before it answers, and the thinking counts against the output token limit. By default `rafiki-fast` and `rafiki-pro` may write up to 64000 output tokens and `rafiki-max` up to 32000, and no reasoning setting is sent, so the model decides how much to think.

If a turn spends its whole output budget thinking and writes no answer, Rafiki Code tries that turn again once, by itself, and says so in one line: "The model used its whole output budget reasoning; trying again once with ...". The retry asks for twice the output (up to the most the model behind the tier can write: 384,000 on `rafiki-fast`, 128,000 on `rafiki-pro` and `rafiki-max`) and, on `rafiki-fast` and `rafiki-max`, one step less reasoning. This happens in the terminal interface and in `rafikicode run`.

If the retry also comes back empty, the reply stops with "The model used its whole output budget reasoning and wrote no answer, also when tried again". Turn reasoning off with the `none` variant:

```bash
rafikicode run --variant none "your request"
```

In the terminal interface, press `ctrl+t` to cycle the model's variants until `none` is selected. To turn reasoning off for every run, set `RAFIKICODE_REASONING_EFFORT=none`. `rafiki-fast` and `rafiki-max` offer the variants `none`, `low`, `medium` and `high`; `rafiki-pro` offers none.

## Context and tokens in the terminal interface

The sidebar's `Context` block and the prompt row describe the last request of the session, as the gateway reported it:

```text
Context
Last request sent 24,530 tokens
20,480 of them cached
2% of the 1M window of Rafiki Fast
412 tokens received
```

- The tokens sent are everything the last request carried: plain input, input read from the cache and input written to the cache, each counted once. Nothing is added up over the session.
- `cached` is the part of that input the provider read from its cache, which costs less. It is inside the tokens sent, not added to them.
- The tokens received are the answer to that request: output and reasoning.
- The percentage is the tokens sent over the window of the tier that answered. `rafiki-fast`, `rafiki-pro` and `rafiki-max` each have a window of 1,000,000 tokens (the documented windows of the models behind them, checked on 4 October 2026). A share under one per cent reads `<1%`.
- A long session is compacted (summarised, so the next requests send less) only near the end of the window of its tier: at the window less the output a request may ask for, about 936,000 tokens on `rafiki-fast` and `rafiki-pro` and 968,000 on `rafiki-max`. Each turn sends the whole conversation, so the cost of a turn grows with the session; start a new session (or run `/compact`) to keep long work cheaper. Old tool output is shortened well before that, see below.

## Long sessions: old tool output

Every turn sends the whole conversation again, and most of it is usually tool output: files read, command output, search results. On the Rafiki tiers, old and large tool outputs are replaced with a one line note, so a long session sends less on every turn without being summarised:

```text
[Output of an earlier bash call (command: npm test) removed to keep the conversation short: 48,894 characters. Run the call again if you need it.]
```

The rule is conservative:

- The latest turn is never touched, and neither is the turn before it.
- The newest 40,000 tokens of tool output stay in full.
- Only outputs of about 500 tokens (2,000 characters) or more are replaced.
- Errors, commands that exited with a non-zero code, file edits and writes, skills and the todo list are always kept.
- Nothing is replaced until at least 20,000 tokens can be removed at once, so the conversation changes in rare batches.

The full output stays in the session on your machine; only what is sent to the model changes. The note names the call and its input, so the agent can run it again when it needs the text.

To turn it off, set `"compaction": {"prune": false}` in your configuration, or `RAFIKICODE_PRUNE=0` for one run. `RAFIKICODE_PRUNE=1` or `"compaction": {"prune": true}` turns it on for other providers too. The environment variable wins over the configuration; the upstream switch `OPENCODE_DISABLE_PRUNE=1` still turns it off when neither is set.

### How it works with prompt caching

Providers bill input they have seen before at a lower rate when a request starts with the same bytes as an earlier one (see `RAFIKICODE_CACHE_MARKERS` above). Replacing old output changes those bytes from the first replaced output onwards, so:

- The start of every request (system prompt, project instructions, tool definitions) is never changed, and on `rafiki-max` its cache marker stays where it is. That part is read from the cache as before.
- The conversation before the first replaced output is still read from the cache. From there on, the request after a batch is written to the cache again, once.
- The note is built only from the call (tool, input, size), so once an output is replaced its text never changes again and is cached like the rest. On `rafiki-max` the markers on the last two messages move forward with the conversation as usual.
- Because a batch removes at least 20,000 tokens, the one cache rewrite costs less than the input it saves on the following turns.

When asked who it is, the agent answers that it is Rafiki Code by PANEOTECH, and names the tier it runs on rather than guessing the model behind it.

## Choosing a tier per project

Put the model in the project file when a repository should always use a given tier:

```json
{
  "model": "rafiki/rafiki-pro"
}
```

Command line flags (`--model`) win over both files for a single run.
