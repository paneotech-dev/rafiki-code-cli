# Using Rafiki Code from your editor

Rafiki Code reaches editors in two ways, and both use the credits in your Rafiki AI account, like the terminal:

- **The full agent through ACP.** ACP (Agent Client Protocol) is an open protocol that lets an editor drive an external coding agent: the editor starts the agent as a child process and they exchange JSON-RPC messages (small JSON requests and answers) over its standard input and output. `rafikicode acp` is such an agent. Zed and JetBrains IDEs speak ACP, so you get the Rafiki Code agent (tiers, your `AGENTS.md`, permissions, clear credit errors) inside the editor's own agent panel.
- **Settings for other tools.** Any tool that accepts an OpenAI compatible endpoint can use the Rafiki AI gateway with a Rafiki AI key and a tier name. Nothing is installed by Rafiki AI. This page covers Cline and Aider.

This page describes `rafikicode` 0.1.4.

## At a glance

| tool | how it connects | model name to type | checked with |
|---|---|---|---|
| Zed, agent panel with Rafiki Code | ACP, `rafikicode acp` | picked in the panel (`rafiki/rafiki-fast` and so on) | Zed 1.19.2 on Linux |
| JetBrains IDEs, AI Chat with Rafiki Code | ACP, `rafikicode acp` | picked in the panel | PyCharm 2026.2.2 with AI Assistant 262.10315.187 on Linux |
| Cline (VS Code) | OpenAI compatible provider | `rafiki-fast` | Cline 4.1.17 in VS Code 1.138.0 (settings page: [Cline settings](./ide-preset.md)) |
| Aider | OpenAI compatible provider | `openai/rafiki-fast` | Aider 0.86.2 |

The tiers are the same everywhere: `rafiki-fast` for everyday work and `rafiki-pro`, which uses more credits per token, for longer tasks. Only the prefix differs, because each tool names providers its own way:

| where | write the tier as |
|---|---|
| `rafikicode` itself, including ACP | `rafiki/rafiki-fast` |
| Cline, plain HTTP calls | `rafiki-fast` |
| Aider | `openai/rafiki-fast` |

Never type a provider model name: the gateway accepts Rafiki tier names only.

## Which key to use

- For ACP, sign in once with `rafikicode login` in a terminal (or set `RAFIKICODE_API_KEY`, see below). The editor never sees the key; `rafikicode` reads it from `~/.rafikicode/credentials` or the environment.
- For Cline and Aider, create a key in the Rafiki AI console at [console.rafikiai.io/keys](https://console.rafikiai.io/keys), tick the Rafiki Code option, and give it a budget you are comfortable with. Use one key per editor: the console shows spend per key, and revoking one editor's key leaves the others working. Avoid copying the key that `rafikicode login` stored: it belongs to your terminal session, and a copy in an editor's settings outlives a `rafikicode logout`.

The gateway base URL for Cline and Aider is:

```text
https://gateway.rafikiai.io/v1
```

## Find the full path of rafikicode

Both ACP setups below start `rafikicode` by its full path. An editor started from a desktop menu or a dock does not read your shell start up file, so its `PATH` usually lacks `~/.rafikicode/bin`, and a bare `rafikicode` in the `command` field means the agent cannot start.

In a terminal where `rafikicode --version` works, run:

```bash
command -v rafikicode
```

It prints the full path, for example `/home/you/.rafikicode/bin/rafikicode` on Linux or `/Users/you/.rafikicode/bin/rafikicode` on macOS. Copy that line into the `command` field exactly. If it prints nothing, the installer's `PATH` change has not reached this terminal: open a new terminal, or write out the installer's location with your own home folder, for example `/home/you/.rafikicode/bin/rafikicode`. Write the path in full, without `~` or `$HOME`.

## The agent's local server

`rafikicode acp` runs a small HTTP server on `127.0.0.1` that only the agent itself uses. The agent protects it with a random password made for that process, so other programs and other users on the machine cannot use it to read your files or run commands. You do not need to set anything. The password is taken out of the agent's environment once the server runs, so commands and tools the agent starts do not inherit it.

If you set `RAFIKICODE_SERVER_PASSWORD` in the `env` block of the agent entry, the agent uses that value instead. The upstream name `OPENCODE_SERVER_PASSWORD` still works when `RAFIKICODE_SERVER_PASSWORD` is not set. Releases up to 0.1.1 had no automatic password and printed `Warning: OPENCODE_SERVER_PASSWORD is not set ...` in the editor's log.

## Zed with the Rafiki Code agent (ACP)

Requirements: `rafikicode` installed and signed in (see [Quick start](./quickstart.md)) and Zed with external agent support (checked with 1.19.2).

1. Find the full path of the binary with `command -v rafikicode`, see [Find the full path of rafikicode](#find-the-full-path-of-rafikicode).

2. In Zed, run the command `agent: open settings`, open the External Agents page, choose Add Agent, then Add Custom Agent. Or add the entry to your user `settings.json` directly (on Linux `~/.config/zed/settings.json`), with the path from step 1:

   ```json
   {
     "agent_servers": {
       "Rafiki Code": {
         "type": "custom",
         "command": "/home/you/.rafikicode/bin/rafikicode",
         "args": ["acp"]
       }
     }
   }
   ```

3. Open the agent panel, open the `+` (new thread) menu and choose Rafiki Code under External Agents. Pick the tier in the model selector at the bottom of the thread; it starts on Rafiki/Rafiki Fast.

Zed opens a folder it has not seen before in Restricted Mode and asks whether to trust it. Trust the folder to use Rafiki Code in it.

Checked with Zed 1.19.2 on Linux: Zed read the entry above from the user settings file, listed Rafiki Code under External Agents, started `rafikicode acp` from the full path, opened a thread with Rafiki/Rafiki Fast selected, and showed the reply to a one line prompt.

## JetBrains IDEs with the Rafiki Code agent (ACP)

ACP agents work in JetBrains IDEs (IntelliJ IDEA, PyCharm, WebStorm and the others) without a JetBrains AI subscription.

1. Open the AI Chat tool window, open the menu in its upper right corner and choose Add Custom Agent. The IDE creates `~/.jetbrains/acp.json`.
2. Add Rafiki Code to that file, with the full path from `command -v rafikicode` (see [Find the full path of rafikicode](#find-the-full-path-of-rafikicode)):

   ```json
   {
     "agent_servers": {
       "Rafiki Code": {
         "command": "/home/you/.rafikicode/bin/rafikicode",
         "args": ["acp"]
       }
     }
   }
   ```

3. Choose Rafiki Code in the agent selector at the bottom of the AI Chat window (the welcome page of AI Chat lists only the built in agents). The tier selector next to it starts on Rafiki/Rafiki Fast.

The IDE reads `acp.json` from the `.jetbrains` folder in your home folder as Java sees it (the home folder of your account, not a `HOME` value set only for the IDE) and registers the agent when the project opens.

Checked with PyCharm 2026.2.2 (build PY-262.10315.174) and the AI Assistant plugin 262.10315.187 on Linux, without a JetBrains account or AI subscription: the IDE accepted the file above, logged `Successfully registered local agent: Rafiki Code`, started `rafikicode acp` from the full path when Rafiki Code was chosen, and showed the reply to a one line prompt. With the gateway unreachable, the chat showed `Cannot reach the model gateway at <url> ... Check the network, and RAFIKICODE_GATEWAY_URL`.

## Signing in for the editor

The agent uses the key that `rafikicode login` stored, so the simplest way is to sign in once in any terminal:

```bash
rafikicode login
```

The command prints a code and a link; approve the code at https://console.rafikiai.io/device with your Rafiki AI account. Then start a new thread in the editor. The same stored key serves your terminals and your editors.

Editors that support terminal sign in also offer a "Login with Rafiki Code" action (ACP method id `rafikicode-login`; the older id `opencode-login` is still accepted). It runs `rafikicode login --surface ide` in a terminal, naming `rafikicode` by the full path of the running binary, so it works when the editor's `PATH` lacks `~/.rafikicode/bin`. `--surface ide` makes the key list of the Rafiki AI console show the key as an editor sign in; the same stored key serves your terminals too. If the action reports a problem, run `rafikicode login` yourself in a terminal instead.

Until you sign in, the agent starts but cannot open a thread: it answers `Authentication required: Rafiki Code needs a Rafiki Console account. ...` (ACP error `auth_required`, code -32000), which editors show as a prompt to sign in. Sign in, or give the agent a key, then start a new thread.

To give the agent an API key instead of a sign in:

- Start the editor from a terminal where `RAFIKICODE_API_KEY` is exported (for example `zed .`); the agent inherits it.
- Or add it to the `env` block of the agent entry: `"env": { "RAFIKICODE_API_KEY": "sk-..." }`. The settings file then holds the key in plain text, so use a dedicated key with a small budget, keep the file readable only by you, and never commit it.

## Cline

Cline is an open source coding agent extension for VS Code. In its settings choose the provider `OpenAI Compatible`, set Base URL to `https://gateway.rafikiai.io/v1`, paste your key, and set the model to `rafiki-fast`. The field by field table and suggested model settings are on the [Cline settings](./ide-preset.md) page.

Checked with Cline 4.1.17 in VS Code 1.138.0 on Linux, using Cline's established interface (VS Code setting `"cline.rollout.bundleOverride": "legacy"`). From the first run screen, "Use your own API key" shows the provider field; the fields were accepted as documented, Cline listed the models from the gateway, and a one line task on `rafiki-fast` ended with "Task Completed".

## Aider

Aider is an open source pair programming tool for the terminal. It reaches the gateway through its OpenAI compatible setting, with the `openai/` prefix in front of the tier:

```bash
export OPENAI_API_BASE=https://gateway.rafikiai.io/v1
export OPENAI_API_KEY=sk-...        # a Rafiki AI key with the Rafiki Code option
aider --model openai/rafiki-fast
```

Or in `.aider.conf.yml` in your home directory (Aider also reads one at the repository root; do not commit a key there):

```yaml
openai-api-base: https://gateway.rafikiai.io/v1
openai-api-key: sk-...
model: openai/rafiki-fast
```

On start Aider warns `Unknown context window size and costs, using sane defaults`. That is expected: it does not know the Rafiki tiers. Add `--no-show-model-warnings` to hide it, and ignore Aider's cost figures; the Rafiki AI console shows the real spend. On first run in a repository Aider also adds `.aider*` to your `.gitignore`.

Checked with Aider 0.86.2: one edit request on `rafiki-fast` changed the requested function and nothing else.

## Output limits

`rafiki-fast` reasons before it answers, and that reasoning counts as output tokens. With a very small output limit (5 tokens in our test) the answer came back empty. Keep the tool's output limit at its default or at least a few hundred tokens.

## How editor usage is labelled

Model calls from `rafikicode acp` carry the surface `ide` (header `X-Rafiki-Surface`), so the gateway and the Rafiki AI console can tell editor spend from terminal spend. Calls from `rafikicode` send the user agent `rafikicode/<version>`. Up to 0.1.1, calls from editors were labelled `cli` and sent the upstream user agent.

The editor's command list does not include the upstream `customize-opencode` command: it described upstream configuration files, not `~/.rafikicode/config.json`.

## Cost and spend

Every request made by these tools uses credits in your Rafiki AI account through the key it uses. The cost figures shown by Cline, Zed, JetBrains or Aider do not reflect Rafiki AI credits; use the key's page in the Rafiki AI console, or `rafikicode whoami` for the terminal key. If a tool reports an authentication error, the key was pasted with extra spaces or has been revoked; for a budget error see [Headless and CI, budget exhaustion](./headless-and-ci.md#budget-exhaustion).
