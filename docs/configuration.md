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
| `channel` | update channel, `"stable"` or `"pre"` (pre-releases too). Unset, a copy installed from a pre-release follows `"pre"` and any other copy `"stable"`. `RAFIKICODE_UPDATE_CHANNEL` wins over it. See [Update channels](./install.md#update-channels) |
| `share` | `"manual"`, `"auto"` or `"disabled"`: whether sessions may be shared through the share service |
| `shell` | default shell for the terminal and the shell tool |
| `username` | name displayed in conversations |
| `instructions` | additional file paths or URLs whose content is added as instructions to every session |
| `permission` | ordered rules deciding which tool actions run without asking, ask, or are denied, for example `{"permission": {"bash": "allow", "edit": "allow"}}` |
| `permission.publish` | commands that publish code (`git push`, `gh pr create`, `gh repo create`, `gh release`) always ask in the interface. `"deny"` refuses them without a question; `"allow"` lets `rafikicode run` push. See [Pushes ask first](./github.md#pushes-ask-first) |
| `permission.mode` | the permission mode when none was picked in the interface: `"ask"` (default), `"auto"` or `"plan"`. See [Permission modes](#permission-modes) |
| `permission.auto_check` | `false` turns off the risk check of auto mode, so a shell command the rules cannot classify runs without it. `true` by default. See [The risk check](#the-risk-check) |
| `agent` | overrides of built-in agents and custom agent definitions |
| `command` | named slash commands |
| `skills` | additional paths or URLs to discover skills from |
| `references` | named local directories or Git repositories available as external context |
| `plugin` | ordered external plugin packages to load |
| `mcp` | Model Context Protocol server configuration (external tool servers the agent can call) |
| `lsp` | language servers. Unset: the TypeScript and JavaScript, Python (pyright) and PHP (intelephense) servers are on, so the errors an edit introduces come back at once (see [Checks after an edit](#checks-after-an-edit)). `false` turns them off, `true` turns every built-in server on, an object configures overrides |
| `formatter` | enable built-in formatters or configure overrides |
| `watcher` | filesystem watcher settings |
| `snapshot` | enable snapshots used for undo and revert |
| `compaction` | conversation compaction behavior for long sessions. `compaction.threshold` (tokens, default `150000` on the Rafiki tiers) is the size of the context at which a session is compacted, see [Context](#context-and-tokens-in-the-terminal-interface); `compaction.warn_at` (tokens, default `200000`, `0` turns it off) is the size of a single request above which one line suggests `/compact` or a new session; `compaction.prune` (`true` or `false`) turns the replacement of old tool output on or off, see [Long sessions: old tool output](#long-sessions-old-tool-output) |
| `memory` | project memory in `.rafiki/memory/`: `memory.enabled` (`true` by default) and `memory.max_bytes` (the size cap, 8,192 by default). See [Project memory](./memory.md) |
| `review` | acceptance criteria at the start of a task (`review.criteria`, `true` by default) and an opt-in review of the change against them before it is done: `review.enabled` (`false` by default), `review.rounds` (0 or 1, 1 by default) and `review.model`. See [Acceptance criteria and the review](#acceptance-criteria-and-the-review) |
| `verify` | the checks that run after a turn that changed files: `verify.enabled` (`true` by default), `verify.commands` (commands to run instead of the detected ones), `verify.timeout` (seconds for one round, 120 by default) and `verify.rounds` (fix rounds after a failure, 2 by default). See [Checks after a change](#checks-after-a-change) |
| `design` | user interface work: `design.guide` (`true` by default) adds the design guide, `design.plan` (`true` by default) asks for a layout plan before building. See [User interface work](#user-interface-work) |
| `attachment` | attachment processing settings |
| `tool_output` | the cap on one tool result: `tool_output.max_bytes` (32,768 by default, about 8,000 tokens) and `tool_output.max_lines` (2,000 by default). See [Large tool results](#large-tool-results) |
| `provider` | provider definitions. The `rafiki` entry is seeded for you; its `whitelist`, `blacklist` and model settings apply |
| `enterprise` | enterprise sharing service settings |
| `experimental` | switches that may change between releases |

The structure of the nested keys (`permission`, `agent`, `mcp`, and so on) is unchanged from the upstream project; the upstream documentation for those sections applies as written.

## Environment variables

| variable | purpose |
|---|---|
| `RAFIKICODE_UPDATE_CHANNEL` | `stable` or `pre`: the update channel for this process, over the `channel` setting. See [Update channels](./install.md#update-channels) |
| `RAFIKICODE_API_KEY` | API key for headless and CI use, created in the Rafiki AI console with the Rafiki Code option ticked. Takes precedence over the stored sign in |
| `RAFIKICODE_GATEWAY_URL` | override the gateway base URL (local test servers). Default `https://gateway.rafikiai.io/v1`. Must be https; plain http is accepted only for `127.0.0.1`, `[::1]` or `localhost`. Any other value is not used, a warning is printed and the key is not sent there. The same rule applies to the gateway URL the console returns at sign in and to a `baseURL` in your own configuration |
| `RAFIKICODE_CACHE_MARKERS` | which tiers carry a prompt cache marker (a field that tells the model provider where the repeated start of a request ends, so it can reuse it at a lower price): `all`, `off`, or tier names separated by commas. Unset, the CLI marks the tiers that need one. Every request starts with the same text in the same order on every tier either way; today's date is sent after that text, in a message of its own |
| `RAFIKICODE_PERMISSION_MODE` | `ask`, `auto` or `plan`: the permission mode of this process, over `permission.mode` and the mode last picked for the project. Picking a mode with Shift+Tab during the session wins over it. See [Permission modes](#permission-modes) |
| `RAFIKICODE_ALLOW_PUSH` | `1` lets `rafikicode run` publish code (`git push`, `gh pr create`, `gh repo create`, `gh release`), like `run --allow-push`. Without it a run refuses them. See [Pushing code from a run](./headless-and-ci.md#pushing-code-from-a-run) |
| `RAFIKICODE_REVIEW` | `1`, `on` or `true` turns the review before a task is done on for this run; `0`, `off` or `false` turns it off. Wins over `review.enabled`. The acceptance criteria do not depend on it. See [Acceptance criteria and the review](#acceptance-criteria-and-the-review) |
| `RAFIKICODE_VERIFY` | `0`, `off` or `false` turns the checks after a change off for this run; `1`, `on` or `true` turns them on. Wins over `verify.enabled`. See [Checks after a change](#checks-after-a-change) |
| `RAFIKICODE_COMPACT_AT` | the size of the context in tokens at which a session is compacted, over `compaction.threshold`. Unset, `150000` on the Rafiki tiers. `0` or `off` compacts only near the gateway's limit of 200,000 input tokens. See [Context](#context-and-tokens-in-the-terminal-interface) |
| `RAFIKICODE_STUCK` | `0`, `off` or `false` turns stuck detection off. See [When the agent is stuck](#when-the-agent-is-stuck) |
| `RAFIKICODE_EDIT_CHECKS` | `0`, `off` or `false` turns the language checks after an edit off, and the default language servers with them. See [Checks after an edit](#checks-after-an-edit) |
| `RAFIKICODE_ROUTING` | `0`, `off` or `false` turns the tier by task off: every request goes to the session's tier. See [Tier by task](#tier-by-task) |
| `RAFIKICODE_WARN_AT` | the size in tokens of a single request above which one line suggests `/compact` or a new session, over `compaction.warn_at`. Unset, `200000`. `0` or `off` turns the line off. See [Context](#context-and-tokens-in-the-terminal-interface) |
| `RAFIKICODE_PRUNE` | `0`, `off` or `false` stops replacing old tool output; `1`, `on` or `true` turns it on, on any provider. Wins over `compaction.prune`. Unset, it is on for the Rafiki tiers. See [Long sessions: old tool output](#long-sessions-old-tool-output) |
| `RAFIKICODE_MEMORY` | `0`, `off` or `false` turns the project memory off for this run; `1`, `on` or `true` turns it on. Wins over `memory.enabled`. See [Project memory](./memory.md) |
| `RAFIKICODE_CONSOLE_URL` | override the Rafiki AI console base URL used by `login`, `logout`, `whoami` and `doctor`. Default `https://console.rafikiai.io`. The key is sent there, so only an https URL is used (plain http only for 127.0.0.1, [::1] or localhost); any other value is ignored with a warning, and so is a console URL on plain http elsewhere returned at sign in |
| `RAFIKICODE_INSTALL_DIR` | installer target directory. Default `~/.rafikicode/bin` |
| `RAFIKICODE_RELEASE_API`, `RAFIKICODE_RELEASE_BASE` | point the installer and `rafikicode update` at another release server (mirrors, tests). Must be https. The installer accepts plain http only for `127.0.0.1` or `[::1]` together with `--allow-http-loopback` or `RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK=1` (local tests); `rafikicode update` follows the same rule with `RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK=1`, and follows a redirect only to a URL that passes it |
| `RAFIKICODE_TRUST_WORKSPACE` | `1` or `true` trusts the workspace of this run, or a list of directories separated by `:`: its project plugins, custom tools, provider packages and settings load. `rafikicode trust` stores the same decision. See [workspace trust](security/workspace-trust.md) |
| `RAFIKICODE_REASONING_EFFORT` | reasoning effort sent on every tier: `none`, `low`, `medium`, `high`, or `default` for no parameter. See [Reasoning and output limits](#reasoning-and-output-limits) |
| `RAFIKICODE_MAX_OUTPUT_TOKENS` | output token limit for every tier, from 1024 to the most the model behind the tier can write (384000 on `rafiki-fast`, 128000 on `rafiki-pro` and `rafiki-max`). A value above a tier's maximum is ignored for that tier |
| `RAFIKICODE_RETRY_WINDOW` | how long, in seconds, a task keeps retrying when the connection to the gateway is lost after the gateway has answered at least once. Default `120`. Retries back off from 2 seconds to 30 seconds with a random part added to each wait. `0` goes back to a single retry. See [When the connection drops](troubleshooting.md#when-the-connection-drops) |
| `RAFIKICODE_DISABLE_PROJECT_CONFIG` | set to `1` or `true` to load nothing from the working tree: no project config files, plugins, tools, skills, MCP servers, formatters or language servers. Alias of `OPENCODE_DISABLE_PROJECT_CONFIG`. See [workspace trust](security/workspace-trust.md) |
| `RAFIKICODE_BROWSER` | path of the Chrome, Chromium, Edge or Brave the `screenshot` tool runs, when it is not in the usual place (`CHROME_PATH` works too). See [User interface work](#user-interface-work) |
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

In the terminal interface, press `ctrl+t` to cycle the model's variants until `none` is selected. To turn reasoning off for every run, set `RAFIKICODE_REASONING_EFFORT=none`. Every tier offers the variants `none`, `low`, `medium` and `high`.

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
- A long session is compacted (summarised, so the next requests send less) once its context reaches 150,000 tokens, on every Rafiki tier, well before the end of the 1M window. The check runs before each request, on the size the request would have, so a request over that size is not sent: the session is compacted first. Each turn sends the whole conversation, so without this the cost of a turn grows with the session up to the full window. `compaction.threshold` in the configuration, or `RAFIKICODE_COMPACT_AT` for one run, moves the point (`RAFIKICODE_COMPACT_AT=off` compacts only at the gateway's limit). A session is never compacted later than 180,000 tokens: the gateway takes at most 200,000 input tokens in one request, and the rest is kept for the answer. When the gateway refuses a request as too large anyway, the session is compacted and the message sent once more, which is not an error; a message too large on its own stops with one line that says so. The percentage stays the share of the real 1M window, so a session is compacted at about 15%. Old tool output is shortened before that, see below. A session is also compacted earlier when its next request would come near the key's tokens per minute limit (shown by `rafikicode doctor` on its `limits` line), since the gateway refuses a single request larger than that limit however long it waits; one line says so.
- When a single request would send more than 200,000 tokens (`compaction.warn_at`, `RAFIKICODE_WARN_AT`), one line in the interface and in `rafikicode run` says so and suggests `/compact` or a new session. With compaction at 150,000 tokens this rarely happens: a turn that adds a very large message, or a higher `compaction.threshold`.

## Large tool results

A single tool result over 32 KB (about 8,000 tokens) or 2,000 lines is not sent whole. The full text is saved to a file in the session's folder, under `tool-output` in the data folder (`~/.local/share/rafikicode/tool-output/<session id>/` on Linux), and the agent gets the start and the end of it, with a note between them:

```text
...38,000 lines truncated...

The tool call succeeded but the output was truncated. The output has 40,000 lines (228,894 bytes); lines 1,001 to 39,000 are not shown in full.
Full output saved to: /home/me/.local/share/rafikicode/tool-output/ses_.../tool_...
Use Grep to search the full content or Read with offset/limit to view specific sections.
```

The agent reads the lines it needs from that file, or searches it, instead of carrying the whole output in every later request. Reading a file gives at most 32 KB per call, with the line to continue from. Saved files are removed after seven days. `"tool_output": {"max_bytes": 51200, "max_lines": 2000}` in your configuration moves the cap.

## Long sessions: old tool output

Every turn sends the whole conversation again, and most of it is usually tool output: files read, command output, search results. On the Rafiki tiers, old and large tool outputs are replaced with a one line note, so a long session sends less on every turn without being summarised:

```text
[Output of an earlier bash call (command: npm test) removed to keep the conversation short: 48,894 characters. Run the call again if you need it.]
```

The rule is conservative:

- The latest turn is never touched, and neither is the turn before it.
- The newest 20,000 tokens of tool output stay in full.
- Only outputs of about 500 tokens (2,000 characters) or more are replaced.
- Errors, commands that exited with a non-zero code, file edits and writes, skills and the todo list are always kept.
- Nothing is replaced until at least 20,000 tokens can be removed at once, so the conversation changes in rare batches.

The full output stays in the session on your machine; only what is sent to the model changes. The note names the call and its input, so the agent can run it again when it needs the text.

To turn it off, set `"compaction": {"prune": false}` in your configuration, or `RAFIKICODE_PRUNE=0` for one run. `RAFIKICODE_PRUNE=1` or `"compaction": {"prune": true}` turns it on for other providers too. The environment variable wins over the configuration; the upstream switch `OPENCODE_DISABLE_PRUNE=1` still turns it off when neither is set.

### How it works with prompt caching

Providers bill input they have seen before at a lower rate when a request starts with the same bytes as an earlier one (see `RAFIKICODE_CACHE_MARKERS` above). Replacing old output changes those bytes from the first replaced output onwards, so:

- The start of every request (system prompt, project instructions, tool definitions, project memory) is never changed during a session. The project instructions (`AGENTS.md` and the files in `instructions`) are read once per session: an edit made during the session is used after the next compaction, or in a new session. The date goes after that part, in a message of its own, and on `rafiki-max` its cache marker stays where it is. That part is read from the cache as before.
- The conversation before the first replaced output is still read from the cache. From there on, the request after a batch is written to the cache again, once.
- The note is built only from the call (tool, input, size), so once an output is replaced its text never changes again and is cached like the rest. On `rafiki-max` the markers on the last two messages move forward with the conversation as usual.
- Because a batch removes at least 20,000 tokens, the one cache rewrite costs less than the input it saves on the following turns.

When asked who it is, the agent answers that it is Rafiki Code by PANEOTECH, and names the tier it runs on rather than guessing the model behind it.

## Permission modes

A permission mode decides how much Rafiki Code asks before a tool runs. There are three:

| mode | what happens |
|---|---|
| Ask | today's behaviour: a tool call asks when the permission rules say `"ask"`, runs when they say `"allow"`, and is refused when they say `"deny"` |
| Auto | tool calls run without a question, except the guarded actions below, which still ask every time |
| Plan | read-only: reading, searching and commands that change nothing run; edits and commands that change things are refused with a note, and the agent describes the change it proposes instead |

In the terminal interface, Shift+Tab cycles Ask, Auto, Plan. The mode shows in the status row under the prompt (`Build · Auto · Rafiki Fast`) and in the footer (`shift+tab auto mode`), and the command palette has "Permission mode" too. The pick is kept per project on your machine, in `~/.local/state/rafikicode/permission-mode.json` (`$XDG_STATE_HOME/rafikicode/` when it is set), never in the project, so nothing about it is committed. The next session in that project starts in the same mode. Shift+Tab used to select the previous agent; that action now has no key by default (`agent_cycle_reverse` in the interface keybinds).

Where the mode comes from, first match wins:

1. `rafikicode run --auto` for that run, or `rafikicode --auto` for that session
2. a mode picked with Shift+Tab during the session
3. `RAFIKICODE_PERMISSION_MODE`
4. the mode last picked in the interface for this project (the interface only)
5. `"permission": { "mode": "auto" }` in the configuration
6. Ask

Your own rules still apply in every mode, and a `"deny"` rule always wins: a command your configuration denies is refused in Auto mode too. An untrusted workspace cannot turn Auto mode on, or its risk check off, from its own `rafikicode.json`; it may choose Ask or Plan.

### Guarded actions

In Auto mode these still ask, each time, with the reason on the question (`Auto mode asks: recursive delete: rm -rf build`), and the question has no "Allow always":

| guarded action | examples |
|---|---|
| publishing code | `git push`, `gh pr create`, `gh repo create`, `gh release` (the publish question, see [Pushes ask first](./github.md#pushes-ask-first)) |
| recursive deletes | `rm -r`, `rm -rf`, `find -delete`, `git clean -d`, `rsync --delete`, `Remove-Item -Recurse` |
| deletes or writes outside the project folder and the temp folder | `rm ../other/file`, `cp app ~/bin/`, `echo x > ../file`, `npm install -g`, an edit of a file in another folder |
| writes to system paths, and commands that change the system | `/etc`, `/usr`, `/var`, `/opt`, `C:\Windows`, `C:\Program Files`; `systemctl`, `apt-get install`, `crontab -r` |
| administrator rights | `sudo`, `su`, `doas`, `pkexec` |
| git history rewrites, on any branch | `git push --force`, `git reset --hard`, `git filter-branch`, `git branch -D` of the default branch |
| a download piped into a shell | `curl ... \| sh`, `wget -O- ... \| bash`, `bash -c "$(curl ...)"`, `sh <(curl ...)` |
| credential files, read or written | `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.npmrc`, `~/.docker/config.json`, a `.env` file outside the project, the Rafiki Code sign-in file |
| a tool that sends email | |
| package publishing | `npm publish`, `pnpm publish`, `cargo publish`, `twine upload`, `gem push`, `docker push` |
| stopping processes this session did not start | `kill 1234`, `pkill node`, `killall`, `taskkill`; `kill` of a process the session started is not guarded |

Shell commands are read the way the shell reads them: lists (`;`, `&&`, `||`), pipes, subshells, command substitutions, `sh -c` and `eval` strings, `if` and `while` bodies, `VAR=value` and `env` prefixes, `sudo`, `timeout`, `nohup` and `xargs` in front, `cd` earlier in the same command, and git aliases. A guarded action anywhere in a command makes the whole command ask. This reads the command line only: a script or program that does any of this by itself is not seen.

To let one guarded command run without the question, write a rule for it by name, for example `{"permission":{"bash":{"rm -rf build":"allow"}}}`. The fixed part of the pattern must cover the guarded words: `"git reset --hard*"` allows `git reset --hard`, while `"git *"`, `"bash": "allow"` or `"*": "allow"` do not. Pushes follow the publish rules instead.

### The risk check

A shell command the rules cannot classify (a program they do not know, inline code such as `python -c "..."`, a script of more than 15 lines) gets a risk check in Auto mode: one small request to the `rafiki-fast` tier with the command and the folder, answered with `{"risk": "low" | "high", "reason": "..."}` (at most 100 output tokens). Low runs the command. High asks you, with the reason. No answer within 5 seconds, an answer that is not that JSON, or no Rafiki key asks you too. The answer is kept for the exact command for the rest of the session, so a command is checked once. The request is made on your key like any other, so it counts in the spend figures and in `rafikicode usage`, under the fast tier.

To turn the risk check off, set `"permission": { "auto_check": false }`; commands the rules cannot classify then run without it.

## Checks after a change

A task is not called done until the project's own checks pass. After a turn that changed files, before the answer is final, Rafiki Code runs the project's tests, type check, lint or build, and sends a failure back to the agent for another fix round.

### Which checks

The checks are found from the project's files, at the root of the repository:

| file | checks |
|---|---|
| `package.json` | the `typecheck` (or `type-check`, `check-types`, `tsc`), `lint` and `test` scripts, and `build` when there is no type check script, run with the package manager of the lock file (`bun run`, `pnpm run`, `yarn run`, else `npm run`). npm's placeholder test script is ignored |
| `pyproject.toml`, `setup.py`, `setup.cfg`, `tox.ini`, `pytest.ini` | `python -m pytest` when pytest is installed, else `python bin/test` when the project has one, else `python -m unittest`; `ruff check .` and `mypy .` when they are configured and installed |
| `go.mod` | `go vet ./...` and `go test` |
| `Cargo.toml` | `cargo check` and `cargo test` |
| `composer.json`, `phpunit.xml` | `vendor/bin/phpunit`, or the `test` and `lint` scripts |
| `Makefile` | the `typecheck`, `lint`, `test` (or `check`) and `build` targets, for what the files above did not give |
| `AGENTS.md` | commands written as code on a line about tests, linting, type checking or building, for what the files above did not give |

What was found is kept for the project until one of these files changes.

To choose the checks yourself, give `AGENTS.md` a `Verify` section. Its code blocks and its list items written as code are the commands, run in order, and nothing is detected:

```markdown
## Verify

- `bun run typecheck`
- `bun test --timeout 30000`
```

A line `verify: npm run check` in `AGENTS.md` does the same. `verify.commands` in the configuration wins over both; in a configured command, `{files}` is replaced by the changed files:

```json
{
  "verify": { "commands": ["ruff check {files}", "python -m pytest -q tests"], "timeout": 300 }
}
```

### Narrowest first

The tests of the changed files run first: for a Python module `pkg/config.py`, the test file `test_config.py` closest to it, else the test files that import the module, else the module's `tests` folder; for JavaScript and TypeScript, the `.test` or `.spec` file named after the changed file (when the test script runs vitest, jest or `bun test`); for Go, the packages of the changed files; for PHP, the matching `*Test.php`. Then the wider checks: build, type check, lint, and the whole test suite only when no narrow test was found.

All of them share one time budget, 120 seconds by default (`verify.timeout`, from 5 to 1800). A command still running when the budget runs out is stopped and reported as not finished, which is not a failure. The first failing command stops the round.

In a monorepo (npm, yarn or bun workspaces, `pnpm-workspace.yaml`, `lerna.json`, `nx.json`, `turbo.json`, or a `composer.json` with `path` repositories), the checks of each package the turn touched run in that package (up to four packages), found from the package's own `package.json`, `composer.json` or `pyproject.toml`; the lockfile at the root decides the package manager. Changed files outside any package, and packages with no checks of their own, get the root's checks. `verify.commands` and an `AGENTS.md` verify section still replace all of this.

A turn that changed only documentation or images (`.md`, `.txt`, `.rst`, images, the licence) is not checked. The checks run through the shell permission like any other command: when shell commands need approval, you are asked first, and a refusal is reported as `checks not run`.

### Fix rounds and the answer

When a check fails, its command, exit code and the end of its output go back to the agent as a new message, and it gets another round to fix the cause, up to `verify.rounds` rounds (2 by default, 0 to 5). A round that ends with exactly the same failure as the round before (same commands, same output) gets no further round, since another one would most likely go the same way. It is asked not to weaken or delete tests, and to say so when a failure was there before its change. The checks run again after each round.

A failure that was there before the turn does not count. When a check fails, it runs once more, within the same budget, with the turn's changed files put back as they were when the turn started (from the session snapshot), and the current files are restored right after. When it fails the same way (the same failing tests or errors, or the same exit code when the output names none), the check is reported as failing before the turn too: it gets no fix round, the next checks still run, and the answer says so (`checks passed: npm run lint; failing before this turn too, not caused by it: npm run test`). This needs session snapshots (on by default); without one, every failure counts. The run before the turn is kept for the turn, so later fix rounds do not repeat it.

The answer then ends with one line:

- `checks passed: <commands>`
- `checks failing: <command> (exit code 1) after 2 fix rounds. The changes are not verified.` when they still fail. The agent never reports success over a failing check.
- `checks not finished within 120 s: <commands>`
- `checks not run: <command> cannot run here (the tool it needs is missing)`, or `... was not approved`
- `no checks found for this project, so the changes were not verified (...)` when nothing was found

In `rafikicode run`, a failed round prints `! checks failed, fix round 1 of 2: <command>`, the `Task:` line ends with the status (`checks passed`, `checks failing`, `checks not finished`, `no checks found`), the JSON output (`--format json`) carries a `verify` event with the status and every command, and the run exits with code 8 when the checks still fail. See [Headless and CI](./headless-and-ci.md#exit-codes).

While the checks are on, the start of every request also carries a short working practice: reproduce a reported bug first (a failing test or a short script), then fix it, run the relevant tests and keep the test; prefer editing over long exploration; and do not try to download packages or reference copies when the network is restricted.

To turn the checks off, set `"verify": {"enabled": false}` in your configuration, or `RAFIKICODE_VERIFY=0` for one run. They are off when project configuration is disabled (`RAFIKICODE_DISABLE_PROJECT_CONFIG`), and subagents do not run them: the task they belong to does.

## Acceptance criteria and the review

At the start of a task that is not trivial, `rafikicode` writes 3 to 5 checkable acceptance criteria from your request, with one short request to Rafiki Fast (to your tier when you chose one, see [Tier by task](#tier-by-task)). They appear at the top of the session's todo list (as `Criterion: ...` items) and are added to the request, so the agent works towards them and checks them before it says the task is done. Trivial requests get none: a request under 40 characters, a question, or a small edit such as a typo or a rename.

When the request reports a bug, the agent reproduces it first: it writes a test next to the existing tests of that code (a short script when the project has no test setup), runs it and sees it fail, fixes the code, runs it again until it passes, and keeps the test. The project's test command is named when one is found. One of the criteria is that reproduction. When the bug cannot be reproduced here, the agent says so and fixes it from the code.

The review is off by default. Turn it on with `"review": {"enabled": true}` in your configuration, or `RAFIKICODE_REVIEW=1` for one run. It costs one more request on every task that changes files, and on our evaluation it caught none of the wrong changes, so it stays opt-in until a stronger setup shows a gain. When it is on, before the task is reported as done, after the checks of the turn, a review runs on Rafiki Pro. It sees only the request, the criteria, the diff of the turn, the results of the checks and the last commands the agent ran, never the whole conversation, and answers pass or fail for each criterion. The criteria met are ticked in the todo list. When some are not met, they go back to the agent with the reasons for one more round (`review.rounds`, 1 by default, 0 for none), then the review runs again. A turn that changed no files, or only documentation, is not reviewed.

The answer then ends with one line, which gives the review's cost (the criteria included):

- `criteria met: 3 of 3 (review on rafiki-pro, 0.004 USD)`
- `criteria not met: 2. <criterion> after 1 review round (review on rafiki-pro, 0.009 USD)`

In `rafikicode run`, the criteria print as `~ criteria: 1. ... 2. ...` and a round as `! review: criteria 2 not met, round 1 of 1`. The JSON output carries a `criteria` event and `review` events (`retry` for a round, then the final status, the model, the cost and each criterion with its result). The cost also counts in the answer's cost.

| setting | meaning |
|---|---|
| `review.criteria` | `true` by default; `false` turns the acceptance criteria and the reproduce first steps off (and with them the review, which needs the criteria) |
| `review.enabled` | `false` by default; `true` turns the review on. `RAFIKICODE_REVIEW=1` or `0` does the same for one run, and wins over it |
| `review.rounds` | extra rounds after a review with criteria not met, 0 or 1 (1 by default) |
| `review.model` | the model of the review as `provider/model`; by default Rafiki Pro on the Rafiki tiers (Rafiki Max on a Rafiki Max session, the session's tier with `RAFIKICODE_ROUTING=off`), else the session's model |

Like the checks, the criteria and the review are off when project configuration is disabled, and subagents do not run them.

## Parallel attempts

A hard task can be done two or three ways at once, keeping only the best change:

- `/attempts 3 <task>` in the terminal interface, or `rafikicode run --attempts 3 "<task>"` (2 or 3).
- `RAFIKICODE_ATTEMPTS=3` gives every `rafikicode run` that many attempts; `RAFIKICODE_ATTEMPTS=off` turns them off, the automatic ones included.
- With `"attempts": { "auto": true }`, `rafikicode run` also uses them by itself on a hard task, by the same signs as [Tier by task](#tier-by-task) that are known before the task starts: `--deep`, or a wide change (a refactor, a migration, a change across the project, five or more files named). Off by default.

Each attempt works in its own copy of the project: a git worktree of the current commit with your uncommitted changes, untracked files and small ignored files at the top (such as `.env`), or a plain copy when the folder is not a git repository. Dependency folders (`node_modules`, `vendor`, `.venv`, `venv`) are linked, not copied, so they are shared: a package an attempt installs is installed for the project too. Git must be installed.

The attempts run on `rafiki-fast` (two Fast attempts cost less than one Pro answer). `"attempts": { "pro": true }`, or `--deep` with attempts, puts the last one on `rafiki-pro`; a model you chose with `--model` is kept. Each attempt gets a short hint with a different approach: the smallest change after reading the code and its callers, a test first, or the way the project already handles similar cases. Each runs the usual [checks](#verify) and, when the task is not trivial, the [acceptance criteria](#acceptance-criteria-and-the-review), and the review when it is on.

The attempt kept is the one whose checks passed; then, when the review is on, the one with more criteria met by the review; ties go to the smaller diff. An attempt that stopped with an error or changed nothing is never kept. Only that change is applied to your working tree; when it no longer applies (you edited the same lines meanwhile), nothing is applied and the patch is saved in the temporary folder, with its path in the summary. Then one line per attempt and the total:

```text
attempt 1 (rafiki-fast, smallest change): checks passed (2 of 2), criteria 3 of 3, +4 -1 in 1 file, 0.012 USD, 95s  [kept]
attempt 2 (rafiki-fast, test first): checks failing (1 of 2 passed), criteria 2 of 3, +31 -2 in 2 files, 0.018 USD, 140s
attempts: kept attempt 1 (checks passed (2 of 2), attempt 2 checks failing (1 of 2 passed)), applied to the working tree; total 0.031 USD
```

The cost of an attempt is the gateway's figure for its requests and its review ("about" when some request had none); the total is the key's spend over all the attempts, read from the gateway. In the terminal interface the results then go to the session, which looks at the applied change and sums it up without doing the task again. `rafikicode run` exits 0 when a change was kept, 8 when it was kept with its checks failing, and 1 when nothing was kept; `--format json` gives an `attempt` event per attempt and a last `attempts` event (the attempt kept, the reason, every attempt, the total `cost`).

The attempts run at the same time while the key's tokens per minute limit leaves about 500,000 tokens per attempt; otherwise fewer run at once and the others wait their turn. Their starts are a few seconds apart, and each one keeps every request under the gateway's input limit as any session does. Every copy and every process is removed at the end, after an error and on Ctrl+C. The attempts run in auto mode in their copies, with its guarded actions refused, since nobody can answer a question there; they never publish code. They cannot be combined with `--continue`, `--session`, `--attach` or `--command`.

| setting | meaning |
|---|---|
| `attempts.auto` | `false` by default; `true` lets `rafikicode run` use attempts on a hard task without being asked |
| `attempts.count` | the number of attempts of an automatic run, 2 or 3 (3 by default) |
| `attempts.pro` | `false` by default; `true` puts the last attempt on `rafiki-pro` |

## Choosing a tier per project

Put the model in the project file when a repository should always use a given tier:

```json
{
  "model": "rafiki/rafiki-pro"
}
```

Command line flags (`--model`) win over both files for a single run.

## Tier by task

When you have not chosen a tier, Rafiki Code picks one per request by what the request is for:

- Explore subagents, session titles, compaction summaries and the acceptance criteria of a task go to `rafiki-fast`.
- The review before a task is done, when you turn it on, always runs on `rafiki-pro` (or the session's tier when it is `rafiki-max`), chosen tier or not: it is a second opinion. See [Acceptance criteria and the review](#acceptance-criteria-and-the-review).
- A turn goes to `rafiki-pro` only on a sign that it is hard: `/deep` (or `rafikicode run --deep`), the plan agent on a wide change (a refactor, a migration, a change across the project, or five or more files named), the same check failing twice in a row after a change, a turn that is stuck (see [When the agent is stuck](#when-the-agent-is-stuck)), or the `/review` step. Never because the conversation is long, and never to `rafiki-max`.
- Before such a turn on a conversation over about 60,000 tokens, the session is compacted first, so `rafiki-pro` does not read the whole history at its price.
- The next turn goes back to the session's tier. The session's tier itself never changes.

You have chosen a tier when you pass `--model`, set `model` in a configuration file, use an agent with a model of its own, or pick one in the terminal interface (the interface always sends the tier it shows). Then every request uses that tier, except a turn you send with `/deep`.

Each choice is written to the debug log (`routing`, with the tier and the reason), and `rafikicode run --format json` gives it on its step events (`tier`, `route`). `RAFIKICODE_ROUTING=off` turns it off.

## User interface work

When a request is user interface work (a page, a component, a layout, CSS or Tailwind, a restyle; or a vague request about files that are mostly `.css`, `.html`, `.vue`, `.svelte` or components), Rafiki Code does three things:

- **Design guide.** A short guide is added to that request: start from the project's own tokens and components, a type scale and a 4px spacing rhythm, colour tokens with contrast of at least 4.5:1, every state designed (hover, focus, disabled, empty, loading, error), mobile first with nothing scrolling sideways at 390px, and the accessibility basics. It is added once per session, at the first such request, and is also the built-in skill `ui-design` for work it did not recognise. `"design": { "guide": false }` turns it off.
- **A layout plan first.** On that request the agent replies with a short plan (the sections in order, the components, the states, the mobile layout) and writes no files until you answer. Reply to build it, or say what to change. Say "no plan" or "just build it" in the request to skip it, or set `"design": { "plan": false }`. There is no plan step in `rafikicode run`, `serve`, `github` and `pr`, in Plan mode (which plans anyway) and in subagents.
- **Screenshots.** The `screenshot` tool opens a local HTML file, a local server or the project's dev server (the `dev`, `start`, `serve` or `preview` script of `package.json`, started in the background) in the Chrome, Chromium, Edge or Brave installed on your machine, headless, at desktop (1440x900) and mobile (390x844) width. It reports sideways overflow, overlapping elements, text below the contrast minimum, images without `alt`, fields without a label, small touch targets and the console errors of the page. Nothing is downloaded or bundled: with no browser installed it says which command installs one (`sudo apt install chromium`, `brew install --cask google-chrome`, `winget install Google.Chrome`); `RAFIKICODE_BROWSER` names one in another place. The browser is stopped after every capture, and after 90 seconds at most.

The pictures go to the model when its tier takes images (`rafiki-fast` and `rafiki-max`). On `rafiki-pro`, which takes none, the routing of [Tier by task](#tier-by-task) sends the screenshots to `rafiki-fast` to be described and the description comes back as text. With routing off, a `rafiki-pro` session works from the measures.

## When the agent is stuck

A turn is stuck when the same tool call fails three times the same way (the same shell command with the same exit code and output, or an edit, write or read failing the same way on the same file), or when its edits keep undoing each other (a file put back to an earlier content twice). The agent is then told so plainly, given the last error to read again, and asked to change approach. You see one line: `Stuck: \`npm test\` failed the same way 3 times; changing approach.` (a notice in the terminal interface, a `!` line in `rafikicode run`, a `stuck` event with `--format json`).

A stuck turn is also a sign that it is hard for the [tier by task](#tier-by-task): when you have not chosen a tier and the turn is on `rafiki-fast`, the rest of it goes to `rafiki-pro`, and the line ends with `now on rafiki-pro`. Never to `rafiki-max`, and the next turn goes back to the session's tier. Each pattern is noted once per turn, two notes at most. `RAFIKICODE_STUCK=off` turns this off.

## Checks after an edit

After every edit, write or patch, the language server of the file reports its errors within 6 seconds, and the ones the edit introduced go back to the agent in the same result (`New errors after this edit in this file, please fix:`). Errors the file had before the edit are left out and counted. A server that is still starting, installing or slow is not waited for longer: it keeps going, and the next edit gets its report.

The TypeScript and JavaScript (the project's own `typescript` package with `typescript-language-server`), Python (pyright) and PHP (intelephense) servers are on unless `lsp` is set. A language server that is not installed is fetched once into the cache, unless `OPENCODE_DISABLE_LSP_DOWNLOAD` is set. For a file no server reported on, a syntax check runs instead when its tool is installed: Python (`compile`), `php -l`, `node --check` for `.mjs`, `.cjs` and `.js` files without JSX, and a JSON parse of `package.json` and `composer.json`, 5 seconds each. `"lsp": false` turns the servers off; `RAFIKICODE_EDIT_CHECKS=off` turns both off.
