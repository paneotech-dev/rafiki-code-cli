<!--
  Built-in skill body. The name and description are registered in code at
  packages/core/src/brand/skill.ts, which also replaces the {{...}} placeholders
  below with the brand values before the model ever sees this text. Never write a
  product name, a config file name or a schema URL here literally: use a
  placeholder, so one brand layer stays the single source of truth.
-->

# Customizing {{PRODUCT}}

{{NAME}} validates its own configuration strictly and refuses to start when a
field has the wrong shape. The shapes below cover the common surface area, but
they are a **summary, not the source of truth**.

## Full schema reference

The authoritative list of every option, with types, enums, defaults and
descriptions, is the JSON Schema for the version that is running:

**<{{SCHEMA}}>**

If a field is not documented here, or you need to confirm an exact shape before
writing config, **fetch that URL and read the schema** rather than guessing. An
invalid config is a refused startup, so the cost of a wrong shape is high.

Every config file should declare `"$schema": "{{SCHEMA}}"` so the user's editor
catches mistakes as they type. {{NAME}} writes that line itself the first time it
loads a file without one.

## Applying changes

Config is read once at startup and is not reloaded. After changing a config file,
an agent file, a command, a skill or a plugin, **tell the user to quit and
restart {{NAME}}**. The running session keeps the configuration it started with.

## Where files live

| Scope            | Path                                                                                |
| ---------------- | ----------------------------------------------------------------------------------- |
| Project config   | `./{{PROJECT_FILE}}`, `./{{PROJECT_FILE_C}}`, or `{{PROJECT_DIR}}/{{PROJECT_FILE}}` |
| Global config    | `{{CONFIG_HINT}}`                                                                   |
| Project agents   | `{{PROJECT_DIR}}/agent/<name>.md` or `{{PROJECT_DIR}}/agents/<name>.md`             |
| Global agents    | `{{CONFIG_DIR}}/agent/<name>.md`                                                    |
| Project commands | `{{PROJECT_DIR}}/command/<name>.md` or `{{PROJECT_DIR}}/commands/<name>.md`         |
| Global commands  | `{{CONFIG_DIR}}/command/<name>.md`                                                  |
| Project skills   | `{{PROJECT_DIR}}/skill/<name>/SKILL.md` or `{{PROJECT_DIR}}/skills/<name>/SKILL.md` |
| Global skills    | `{{CONFIG_DIR}}/skill/<name>/SKILL.md`                                              |
| Project plugins  | `{{PROJECT_DIR}}/plugin/*.ts` or `{{PROJECT_DIR}}/plugins/*.ts`                     |

A project config is searched for from the working directory upwards to the
repository root, so a file at the root applies to every directory under it.
Configs from each scope are deep-merged, and the project scope overrides the
global one. Use `{{NAME}} doctor` to see exactly which files are loaded and
whether any of them is rejected.

## Workspace trust

This is specific to {{PRODUCT}} and is the usual reason a config that looks right
has no effect: **code and commands a project directory declares only load in a
trusted workspace**. Until the user trusts the directory, these are dropped, with
a warning:

- project plugins and custom tools
- local MCP servers, formatters and language server commands declared by the project
- permission rules the project config grants

Everything else in a project config (model, instructions, agents without code,
and so on) still applies. To trust a directory: `{{NAME}} trust <dir>`, or
`{{ENV_TRUST}}=1` for one run. Never suggest turning trust off for a repository
the user did not write.

## Models and providers

{{PRODUCT}} runs one provider, `{{PROVIDER}}`, through its own gateway. The
model tiers are:

{{MODEL_LIST}}

A `model` value always carries the provider prefix, for example
`"{{DEFAULT_MODEL}}"`. `enabled_providers` and `disabled_providers` are fixed by
the product and cannot be widened from a config file, so do not write them, and
do not add `provider` blocks for other services: they will not be offered. A
model outside the gateway is not metered on the user's account.

## The config file

Every field is optional.

```json
{
  "$schema": "{{SCHEMA}}",
  "username": "string",
  "model": "{{DEFAULT_MODEL}}",
  "small_model": "{{DEFAULT_MODEL}}",
  "default_agent": "agent-name",
  "shell": "/bin/zsh",
  "logLevel": "DEBUG" | "INFO" | "WARN" | "ERROR",
  "share": "manual" | "auto" | "disabled",
  "autoupdate": true | false | "notify",
  "snapshot": true,
  "instructions": ["AGENTS.md", "docs/style.md"],

  "skills": {
    "paths": ["{{PROJECT_DIR}}/skills", "/abs/path/to/skills"],
    "urls": ["https://example.com/.well-known/skills/"]
  },

  "references": {
    "docs": { "path": "../docs", "description": "Use for product behavior" },
    "sdk": { "repository": "owner/sdk", "branch": "main", "hidden": true }
  },

  "agent": {
    "my-agent": {
      "description": "...",
      "mode": "subagent",
      "model": "{{DEFAULT_MODEL}}",
      "permission": { "edit": "deny" }
    }
  },

  "command": {
    "deploy": { "description": "...", "template": "..." }
  },

  "mcp": {
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp"],
      "enabled": true,
      "environment": {}
    },
    "remote-thing": {
      "type": "remote",
      "url": "https://...",
      "headers": { "Authorization": "Bearer ..." }
    }
  },

  "plugin": ["./local-plugin.ts", ["some-plugin", { "option": "value" }]],

  "permission": {
    "edit": "deny",
    "bash": { "git *": "allow", "*": "ask" }
  },

  "formatter": false,
  "lsp": false,

  "experimental": { "primary_tools": ["edit"], "mcp_timeout": 30000 },
  "tool_output": { "max_lines": 200, "max_bytes": 8192 },
  "compaction": { "auto": true, "tail_turns": 15 }
}
```

Shapes that are got wrong most often:

- `model` always carries a provider prefix.
- `skills` is an object with `paths` and/or `urls`. A plain array of paths and URLs is still accepted and split into the two, but write the object form.
- `agent` and `command` are objects keyed by name, not arrays.
- `plugin` is an array of strings or `[name, options]` tuples, not an object.
- `mcp[name].command` is an array of strings, never one string, and `type` is required.
- `permission` is either a single action string or an object keyed by tool name.
- The key is `permission`, singular. `permissions` is refused with an explicit error, at the top level and inside an agent.
- `references` is an object keyed by the alias used in `@` autocomplete. Each value is a local `path`, a Git `repository`, or a string shorthand.

Unknown top-level keys are ignored rather than refused, so a typo in a key name
fails silently: check the spelling against the schema instead of assuming a
setting took effect.

## Skills

The skill loader scans for `**/SKILL.md` inside skill directories. The file is
named `SKILL.md` exactly and lives in its own folder named after the skill:

```
{{PROJECT_DIR}}/skills/my-skill/SKILL.md
```

```markdown
---
name: my-skill
description: One sentence covering what this skill does AND when to trigger it. Front-load the literal keywords or filenames the user is likely to say.
---

# My Skill

(skill body in markdown: instructions, examples, references)
```

- `name` is required, lowercase hyphen-separated, up to 64 characters, and matches the folder name.
- `description` is effectively required: a skill without one is filtered out and never reaches the model. Cover both what it does and when to use it, in third person ("Use when..."). Gate with "Use ONLY when..." if it should stay quiet on adjacent topics.
- Optional: `license`, `compatibility`, `metadata` (a string to string map).

Skills in other locations are registered through `skills.paths` (scanned
recursively) and `skills.urls`. Skills under `~/.claude/skills/` and
`~/.agents/skills/` are picked up automatically.

## Agents

Two forms. Use the file form for anything non-trivial.

```
{{PROJECT_DIR}}/agent/my-reviewer.md
```

```markdown
---
description: Reviews changes for style violations.
mode: subagent
model: "{{DEFAULT_MODEL}}"
permission:
  edit: deny
  bash: ask
---

You are a strict reviewer. Focus on...
```

The body becomes the agent's prompt; do not also put `prompt:` in the
frontmatter. `mode` is one of `"primary"`, `"subagent"`, `"all"`.

Allowed top-level frontmatter fields: `name, model, variant, description, mode,
hidden, color, steps, options, permission, disable, temperature, top_p`. An
unknown field is routed silently into `options`.

Built-in agents: `build`, `plan`, `general`, `explore`, plus the hidden internal
`compaction`, `title` and `summary`. Override a built-in by defining the same key
under `agent`. Disable one with `agent: { build: { disable: true } }`, or
`disable: true` in its file's frontmatter. `default_agent` must name a
non-hidden, primary-mode agent.

## Commands

The command loader scans for `**/*.md` inside command directories. The file is
named after the command:

```
{{PROJECT_DIR}}/command/deploy.md
```

```markdown
---
description: One sentence describing what the command does.
agent: build
---

(the prompt to run, with $ARGUMENTS for the user's input)
```

- The body is the command's `template` and is required. Do not also put a `template:` key in the frontmatter.
- `$ARGUMENTS` is replaced with everything typed after the command; `$1`, `$2`, ... take individual positional arguments.
- Optional: `description`, `agent`, `model`, `variant`, `subtask`.

## Plugins

`plugin` is an array. Each entry is an npm spec, a file path relative to the
declaring config, a file URL, or a `[name, options]` tuple. Any `*.ts` or `*.js`
file in `{{PROJECT_DIR}}/plugin/` is discovered without a config entry.

A plugin module exports a function, not an object literal, and that function
returns an object (return `{}` when there is nothing to register).

```ts
import type { Plugin } from "@opencode-ai/plugin"

export default (async ({ client, project, directory, $ }) => {
  return {
    config: (cfg) => {
      // cfg is the live merged config; mutate fields here.
    },
    "tool.execute.before": async (input, output) => {
      // mutate output.args before the tool runs
    },
  }
}) satisfies Plugin
```

Hooks (mutate `output` in place, return `void`): `event`, `config`,
`chat.message`, `chat.params`, `chat.headers`, `tool.execute.before`,
`tool.execute.after`, `tool.definition`, `command.execute.before`, `shell.env`,
`permission.ask`, and the `experimental.*` transforms. Object-shaped rather than
callbacks: `tool`, `auth`, `provider`.

Remember that a project plugin does not load at all until the workspace is
trusted.

## Permissions

```json
"permission": {
  "edit": "deny",
  "bash": { "git *": "allow", "rm *": "deny", "*": "ask" },
  "external_directory": { "~/secrets/**": "deny", "*": "allow" }
}
```

Actions: `"allow"`, `"ask"`, `"deny"`. A per-tool value is either the `"allow"`
shorthand (meaning `{"*": "allow"}`) or an object of pattern to action. Within an
object **insertion order matters**: the LAST matching rule wins, so put broad
rules first and narrow rules last.

Known keys: `read, edit, glob, grep, list, bash, task, external_directory,
todowrite, question, webfetch, websearch, lsp, doom_loop, skill`. Of these,
`todowrite`, `question`, `webfetch`, `websearch` and `doom_loop` take a flat
action only, not a per-pattern object. `external_directory` patterns are
filesystem paths.

A per-agent `permission` overrides the top-level one. Plan mode is the `plan`
agent's ruleset.

`permission: "allow"` as a bare string at the top level means "allow
everything", and is rarely what the user wants.

## When the config is broken

If {{NAME}} refuses to start because of a config file:

1. `{{NAME}} doctor` names the file and the field, and says what to change.
2. `{{ENV_DISABLE_PROJECT}}=1` starts without anything from the working tree, so
   the user can open {{NAME}} in the repository and fix the file from inside it.
3. Moving the global config file aside is safe: it is recreated with defaults.

## When proposing edits

- Validate against the schema before writing. If unsure of a field's exact shape, fetch `{{SCHEMA}}` and read it rather than guessing.
- Preserve `$schema` and every field the user did not ask to change.
- Prefer new files in the right directory over inlining agents, commands, skills and plugins into the config file.
- After saving any config change, remind the user to quit and restart {{NAME}}.
