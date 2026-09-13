# Configuration

`rafikicode` reads configuration from a global file, an optional project file, and a few environment variables. Later sources override earlier ones: built-in defaults, then the global file, then the project file, then environment variables and command line flags.

## Files

| location | purpose |
|---|---|
| `~/.rafikicode/config.json` | global settings for your user. Created on first run with the built-in defaults |
| `~/.rafikicode/AGENTS.md` | instructions applied to every project |
| `~/.rafikicode/credentials` | the key stored by `rafikicode login`, mode 0600. Do not edit by hand; `logout` removes it |
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

- `autoupdate` is `false`. The CLI never replaces itself unless you run `rafikicode update`. Set it to `true` or `"notify"` to change that.
- The `rafiki` provider is registered automatically once a credential exists (a stored login or `RAFIKICODE_API_KEY`), pointing at the gateway with the three aliases `rafiki-fast`, `rafiki-pro` and `rafiki-max`. Without a credential no provider is registered and the CLI tells you to sign in.

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
| `permissions` | ordered rules deciding which tool actions run without asking, ask, or are denied |
| `agents` | overrides of built-in agents and custom agent definitions |
| `commands` | named slash commands |
| `skills` | additional paths or URLs to discover skills from |
| `references` | named local directories or Git repositories available as external context |
| `plugins` | ordered external plugin packages to load |
| `mcp` | Model Context Protocol server configuration (external tool servers the agent can call) |
| `lsp` | enable built-in language servers or configure overrides |
| `formatter` | enable built-in formatters or configure overrides |
| `watcher` | filesystem watcher settings |
| `snapshots` | enable snapshots used for undo and revert |
| `compaction` | conversation compaction behavior for long sessions |
| `attachments` | attachment processing settings |
| `tool_output` | truncation thresholds for tool output |
| `providers` | provider definitions. The `rafiki` entry is seeded for you; add others only if you have your own keys, they are not metered by the wallet |
| `enterprise` | enterprise sharing service settings |
| `experimental` | switches that may change between releases |

The structure of the nested keys (`permissions`, `agents`, `mcp`, and so on) is unchanged from the upstream project; the upstream documentation for those sections applies as written.

## Environment variables

| variable | purpose |
|---|---|
| `RAFIKICODE_API_KEY` | server key for headless and CI use. Takes precedence over the stored login |
| `RAFIKICODE_GATEWAY_URL` | override the gateway base URL (local mocks, staging). Default `https://gateway.rafikiai.io/v1` |
| `RAFIKICODE_CONSOLE_URL` | override the Console base URL used by `login`, `logout` and `whoami`. Default `https://console.rafikiai.io` |
| `RAFIKICODE_INSTALL_DIR` | installer target directory. Default `~/.rafikicode/bin` |
| `RAFIKICODE_RELEASE_API`, `RAFIKICODE_RELEASE_BASE` | point the installer and `rafikicode update` at another release server (mirrors, tests) |
| `OPENCODE_CONFIG_DIR` | add another configuration directory, read as `config.json`, `rafikicode.json`, or `rafikicode.jsonc` there |
| `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SERVER_USERNAME` | basic authentication for `rafikicode serve` and `attach` |
| `OPENCODE_*` | other advanced switches keep their upstream names so upstream documentation and plugins keep working |

## Choosing a tier per project

Put the model in the project file when a repository should always use a given tier:

```json
{
  "model": "rafiki/rafiki-pro"
}
```

Command line flags (`--model`) win over both files for a single run.
