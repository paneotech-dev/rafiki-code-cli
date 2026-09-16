# Using Rafiki Code from your editor

Rafiki Code reaches editors in two ways, and both spend from the same Rafiki Console wallet as the terminal:

- **The full agent through ACP.** ACP (Agent Client Protocol) is an open protocol that lets an editor drive an external coding agent: the editor starts the agent as a child process and they exchange JSON-RPC messages (small JSON requests and answers) over its standard input and output. `rafikicode acp` is such an agent. Zed and JetBrains IDEs speak ACP, so you get the Rafiki agent (tiers, your `AGENTS.md`, permissions, clear wallet errors) inside the editor's own agent panel.
- **Presets for other tools.** A preset is a documented configuration for a third party tool; nothing is installed by Rafiki. Any tool that accepts an OpenAI compatible endpoint can use the Rafiki gateway with a Rafiki key and a tier name. This page covers Cline, the Zed agent panel, JetBrains AI Assistant and Aider.

VS Code has its own Rafiki Code extension, which opens `rafikicode` in an editor tab and adds sign in, a status bar item and a tier picker: see [Rafiki Code for VS Code](./vscode.md).

Each section says whether it was tested, and how. The Zed, JetBrains and Cline checks on this page ran on Linux on 16 September 2026, with `rafikicode` 0.1.3 and a stand in gateway (a local OpenAI compatible test server that answers every request with a fixed reply), so they prove the configuration and the protocol, not answer quality. "Not yet tested" means the configuration follows the tool's own documentation as of September 2026 but nobody has run it in that editor yet; tell us if a field is named differently in your version.

## At a glance

| tool | how it connects | model name to type | tested |
|---|---|---|---|
| Zed, agent panel with Rafiki Code | ACP, `rafikicode acp` | picked in the panel (`rafiki/rafiki-fast` and so on) | tested on 16 September 2026, Zed 1.19.2 |
| JetBrains IDEs, AI Chat with Rafiki Code | ACP, `rafikicode acp` | picked in the panel | tested on 16 September 2026, PyCharm 2026.2.2 with AI Assistant 262.10315.187 |
| Cline (VS Code) | OpenAI compatible provider | `rafiki-fast` | tested on 16 September 2026, Cline 4.1.17 in VS Code 1.138.0 (settings page: [Cline preset](./ide-preset.md)) |
| Zed, agent panel with its own models | OpenAI compatible provider | `rafiki-fast` | not yet tested |
| JetBrains AI Assistant | OpenAI compatible provider | `rafiki-fast` | not yet tested |
| Aider | OpenAI compatible provider | `openai/rafiki-fast` | tested on 16 September 2026, Aider 0.86.2 |

The three tiers are the same everywhere: `rafiki-fast` (1x credits), `rafiki-pro` (4x) and `rafiki-max` (15x). Only the prefix differs, because each tool names providers its own way:

| where | write the tier as |
|---|---|
| `rafikicode` itself, including ACP | `rafiki/rafiki-fast` |
| Cline, Zed provider, JetBrains AI Assistant, plain HTTP calls | `rafiki-fast` |
| Aider | `openai/rafiki-fast` |

Never type a provider model name: the gateway accepts the three tier names only.

## Which key to use

- For ACP, sign in once with `rafikicode login` (or set `RAFIKICODE_API_KEY`, see below). The editor never sees the key; `rafikicode` reads it from `~/.rafikicode/credentials` or the environment.
- For presets, create a server key at [console.rafikiai.io/keys](https://console.rafikiai.io/keys), one per editor, with a budget you are comfortable with. The Console shows spend per key, and revoking one editor's key leaves the others working. Avoid copying the key that `rafikicode login` stored: it belongs to your terminal session, and a copy in an editor's settings outlives a `rafikicode logout`.

The gateway base URL for every preset is:

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

## Zed with the Rafiki Code agent (ACP)

Requirements: `rafikicode` installed (see [Quick start](./quickstart.md)) and Zed with external agent support (tested with 1.19.2).

1. Find the full path of the binary with `command -v rafikicode`, see [Find the full path of rafikicode](#find-the-full-path-of-rafikicode).

2. In Zed, run the command `agent: open settings`, open the External Agents page, choose Add Agent, then Add Custom Agent. Or add the entry to your user `settings.json` directly (on Linux `~/.config/zed/settings.json`), with the path from step 1:

   ```json
   {
     "agent_servers": {
       "Rafiki Code": {
         "type": "custom",
         "command": "/home/you/.rafikicode/bin/rafikicode",
         "args": ["acp"],
         "env": {}
       }
     }
   }
   ```

3. Open the agent panel, open the `+` (new thread) menu and choose Rafiki Code under External Agents. Pick the tier in the model selector at the bottom of the thread; it starts on Rafiki/Rafiki Fast.

Zed opens a folder it has not seen before in Restricted Mode and asks whether to trust it. The check below trusted the folder first; Rafiki Code in a folder left in Restricted Mode was not tried.

Status: tested on 16 September 2026 with Zed 1.19.2 on Linux. Zed read the entry above from the user settings file, listed Rafiki Code under External Agents, started `rafikicode acp` from the full path, opened a thread with Rafiki/Rafiki Fast selected, and showed the reply to a one line prompt. Both requests of the turn (the thread title and the answer) reached the gateway on `rafiki-fast` with the key from the `env` block.

## JetBrains IDEs with the Rafiki Code agent (ACP)

ACP agents work in JetBrains IDEs (IntelliJ IDEA, PyCharm, WebStorm and the others) without a JetBrains AI subscription.

1. Open the AI Chat tool window, open the menu in its upper right corner and choose Add Custom Agent. The IDE creates `~/.jetbrains/acp.json`.
2. Add Rafiki Code to that file, with the full path from `command -v rafikicode` (see [Find the full path of rafikicode](#find-the-full-path-of-rafikicode)):

   ```json
   {
     "agent_servers": {
       "Rafiki Code": {
         "command": "/home/you/.rafikicode/bin/rafikicode",
         "args": ["acp"],
         "env": {}
       }
     }
   }
   ```

3. Choose Rafiki Code in the agent selector at the bottom of the AI Chat window (the welcome page of AI Chat lists only the built in agents). The tier selector next to it starts on Rafiki/Rafiki Fast.

The IDE reads `acp.json` from the `.jetbrains` folder in your home folder as Java sees it (the home folder of your account, not a `HOME` value set only for the IDE) and registers the agent when the project opens. The IDE also offers Rafiki Code its own tools through a private MCP connection (in PyCharm they appear as tools such as `pycharm_apply_patch`); using those tools was not tested.

Status: tested on 16 September 2026 with PyCharm 2026.2.2 (build PY-262.10315.174) and the AI Assistant plugin 262.10315.187 on Linux, without a JetBrains account or AI subscription. The IDE accepted the file above, logged `Successfully registered local agent: Rafiki Code`, started `rafikicode acp` from the full path when Rafiki Code was chosen, and showed the reply to a one line prompt; the request reached the gateway on `rafiki-fast` with the key from the `env` block. With the gateway unreachable, the chat showed `Cannot reach the model gateway at <url> ... Check the network, and RAFIKICODE_GATEWAY_URL`. Other JetBrains IDEs share the AI Assistant plugin but were not run, and the minimum IDE version for custom agents is not confirmed.

## Signing in from the editor

When the editor supports terminal sign in, Rafiki Code offers one sign in method, "Login with Rafiki Code" (method id `rafikicode-login` from 0.1.3; earlier releases used `opencode-login`, which is still accepted). Choosing it runs `rafikicode login --surface ide` in a terminal: the command prints a code and a link, you approve the code at console.rafikiai.io/device, and the key is stored in `~/.rafikicode/credentials`. `--surface ide` makes the Console list the key as an editor sign in; the same stored key serves your terminals too. From 0.1.3 the sign in method names `rafikicode` by the full path of the running binary, so it works when the editor's `PATH` lacks `~/.rafikicode/bin`; with 0.1.2 and earlier it runs plain `rafikicode login`, found through the editor's `PATH`. If sign in reports that the command is missing, run `rafikicode login` yourself in any terminal instead; the agent picks the stored key up on its next start.

Always write the full path of the binary in the `command` field of `agent_servers` (the output of `command -v rafikicode`, for example `/home/you/.rafikicode/bin/rafikicode`): a bare `rafikicode` fails in an editor started from a desktop menu, whose `PATH` usually lacks `~/.rafikicode/bin`.

Until you sign in, the agent starts but cannot open a thread. From 0.1.3 it answers with `Authentication required: Rafiki Code needs a Rafiki Console account. ...` (ACP error `auth_required`), which editors show as a prompt to sign in. With 0.1.2 and earlier the thread opened with an empty model selector (the agent reports `unknown/unknown`) and prompts could not run. Sign in, or give it a key, then start a new thread.

How the agent reports and protects itself (changed after 0.1.3; 0.1.3 and earlier behave as noted):

- Model calls from `rafikicode acp` carry the surface `ide` (header `X-Rafiki-Surface`), so the gateway and the Console can tell editor spend from terminal spend. In 0.1.3 and earlier they carried `cli`. Calls send the user agent `rafikicode/<version>`; 0.1.3 and earlier sent the upstream name.
- `rafikicode acp` runs a small HTTP server on `127.0.0.1` that only the agent itself uses. When you have not set `RAFIKICODE_SERVER_PASSWORD`, the agent protects that server with a random password for that process, so other programs and other users on the machine cannot use it to read your files or open a terminal. 0.1.3 and earlier left it without a password and printed `Warning: OPENCODE_SERVER_PASSWORD is not set ...` to the editor's log; on a shared machine, use a newer release, or with 0.1.3 set `OPENCODE_SERVER_PASSWORD` (the name 0.1.3 reads) to a long random value in the `env` block of the agent entry.
- The upstream `customize-opencode` command is no longer offered in the editor's command list: it described upstream configuration files, not `~/.rafikicode/config.json`.

If browser sign in is not available to you yet, give the agent a server key through the environment instead:

- Start the editor from a terminal where `RAFIKICODE_API_KEY` is exported (for example `zed .`); the agent inherits it.
- Or put it in the `env` block of the agent entry: `"env": {"RAFIKICODE_API_KEY": "sk-..."}`. The settings file then holds the key in plain text, so use a dedicated key with a small budget, keep the file readable only by you, and never commit it.

## Cline

Cline is an open source coding agent extension for VS Code (a JetBrains plugin also exists). In its settings choose the provider `OpenAI Compatible`, set Base URL to `https://gateway.rafikiai.io/v1`, paste your key, and set the model to `rafiki-fast`. The field by field table and suggested model settings are on the [Cline preset](./ide-preset.md) page.

Status: tested on 16 September 2026 with Cline 4.1.17 in VS Code 1.138.0 on Linux, using Cline's established interface (VS Code setting `"cline.rollout.bundleOverride": "legacy"`). From the first run screen, "Use your own API key" shows the provider field; the fields were accepted as documented, Cline listed the models from the gateway, and a one line task on `rafiki-fast` ended with "Task Completed" and the gateway's reply. Cline's newer interface (`"next"`, rolling out gradually) was not tried.

## Zed with its own models (OpenAI compatible provider)

Zed's agent panel can also use the gateway directly, with Zed's own agent instead of Rafiki Code. Add a provider to `settings.json`:

```json
{
  "language_models": {
    "openai_compatible": {
      "rafiki": {
        "api_url": "https://gateway.rafikiai.io/v1",
        "available_models": [
          { "name": "rafiki-fast", "display_name": "Rafiki Fast", "max_tokens": 128000, "capabilities": { "tools": true, "images": false, "parallel_tool_calls": false } },
          { "name": "rafiki-pro", "display_name": "Rafiki Pro", "max_tokens": 128000, "capabilities": { "tools": true, "images": false, "parallel_tool_calls": false } },
          { "name": "rafiki-max", "display_name": "Rafiki Max", "max_tokens": 128000, "capabilities": { "tools": true, "images": false, "parallel_tool_calls": false } }
        ]
      }
    }
  }
}
```

Enter the key in the provider's settings screen, or set the environment variable Zed derives from the provider name, here `RAFIKI_API_KEY`. Do not write the key into `settings.json`. The three models then appear in the agent panel's model menu.

Status: not yet tested. The capability flags are a cautious starting point.

## JetBrains AI Assistant (bring your own key)

1. Open Settings, Tools, AI Assistant, Providers and API keys.
2. In the third party providers section, add an OpenAI compatible provider with the endpoint URL `https://gateway.rafikiai.io/v1` and your key, turn tool calling on, and test the connection. If the test fails with the `/v1` suffix, try `https://gateway.rafikiai.io`, since the field's expected form is not documented.
3. In AI Chat, pick `rafiki-fast`, `rafiki-pro` or `rafiki-max` from the provider's section of the model selector. The gateway lists exactly these three.

Status: not yet tested.

## Aider

Aider is an open source pair programming tool for the terminal. It reaches the gateway through its OpenAI compatible setting, with the `openai/` prefix in front of the tier:

```bash
export OPENAI_API_BASE=https://gateway.rafikiai.io/v1
export OPENAI_API_KEY=sk-...        # a Rafiki server key
aider --model openai/rafiki-fast
```

Or in `.aider.conf.yml` in your home directory (Aider also reads one at the repository root; do not commit a key there):

```yaml
openai-api-base: https://gateway.rafikiai.io/v1
openai-api-key: sk-...
model: openai/rafiki-fast
```

On start Aider warns `Unknown context window size and costs, using sane defaults`. That is expected: it does not know the Rafiki tiers. Add `--no-show-model-warnings` to hide it, and ignore Aider's cost figures; the Console shows the real spend. On first run in a repository Aider also adds `.aider*` to your `.gitignore`.

Status: tested on 16 September 2026 with Aider 0.86.2. One edit request on `rafiki-fast` changed the requested function and nothing else (825 tokens sent, 150 received).

## What was tested

On 16 September 2026, with `rafikicode` 0.1.3, a test key and a stand in gateway, on Linux, in each editor:

- Zed 1.19.2: the Zed entry above in the user settings file, trusted folder, Rafiki Code thread, one prompt. Reply shown; two requests (title and answer) on `rafiki-fast` with the test key.
- PyCharm 2026.2.2 with AI Assistant 262.10315.187: the JetBrains entry above in `~/.jetbrains/acp.json`, Rafiki Code chosen in the AI Chat agent selector, one prompt. Reply shown; one request on `rafiki-fast` with the test key.
- Cline 4.1.17 in VS Code 1.138.0: OpenAI Compatible provider with the base URL, key and model fields from the [Cline preset](./ide-preset.md). Model list read, one task completed on `rafiki-fast` with the test key.
- ACP without an editor, on the same 0.1.3 build: `initialize` answered as `Rafiki Code` 0.1.3 with the `rafikicode-login` sign in method; `session/new` listed the three tiers with `rafiki/rafiki-fast` selected; one prompt ended with stop reason `end_turn`. Without a key, `session/new` answered `auth_required`.

Earlier on the same day, with `rafikicode` 0.1.1 and a test key, on Linux:

- ACP without an editor: a small script started `rafikicode acp`, sent `initialize` announcing terminal sign in, then `session/new`, then one prompt. The agent answered as `Rafiki Code` 0.1.1 with the sign in method above, listed `rafiki/rafiki-fast`, `rafiki/rafiki-pro` and `rafiki/rafiki-max` with `rafiki/rafiki-fast` selected, and replied to the prompt (stop reason `end_turn`). Without a key, `session/new` still succeeded but listed no models.
- The gateway: `GET /v1/models` listed the three tiers, and one chat completion on `rafiki-fast` answered.
- With a local 0.1.3 build, the same script without a key: `initialize` offered `rafikicode-login` with the terminal sign in command set to the full path of the binary and the arguments `login --surface ide`, and `authenticate` answered `auth_required`. `rafikicode login --surface ide` against a stand in Console asked for the device code as surface `ide`, with the label `rafikicode 0.1.3 in an editor on <host>`. The live Console accepts `ide` for this request; a sign in with it against the live Console was not run.
- Aider, as described above.

A note for any preset: `rafiki-fast` reasons before it answers (56 of 58 output tokens in our one word test), and that reasoning counts as output tokens. With a very small output limit (5 tokens in our test) the answer came back empty. Keep the tool's output limit at its default or at least a few hundred tokens.

Not yet tested: JetBrains IDEs other than PyCharm, JetBrains AI Assistant with its own models, Zed with its own models, Cline's newer interface, the sign in action from an editor (all editor checks used a key in the `env` block or the provider settings), a real gateway from an editor, and every platform other than Linux.

## Cost and spend

Every request made by these tools is charged to the key it uses, at the tier's multiplier. The cost figures shown by Cline, Zed, JetBrains or Aider do not reflect Rafiki credits; use the key's page in the Console, or `rafikicode whoami` for the terminal key. If a tool reports an authentication error, the key was pasted with extra spaces or has been revoked; for a budget error see [Headless and CI, budget exhaustion](./headless-and-ci.md#budget-exhaustion).
