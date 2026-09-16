# Cline settings

Cline is an open source coding agent extension for VS Code. It can talk to any OpenAI compatible endpoint, and the Rafiki AI gateway is one, so Cline can use the credits in your Rafiki AI account, like `rafikicode`. Nothing is installed by Rafiki AI; this page is configuration only.

## What you need

- VS Code with the Cline extension installed from the marketplace.
- A Rafiki AI key: create one in the Rafiki AI console at [console.rafikiai.io/keys](https://console.rafikiai.io/keys) and tick the Rafiki Code option. Use a dedicated key for Cline, since the console shows spend per key and you can revoke it without signing your terminal out.

## Settings

Open the Cline settings panel with the gear icon in the Cline view, then fill in the provider section as follows. Field names are as they appear in Cline 4.1.17 (checked in VS Code 1.138.0, see [Cline](./ide.md#cline)). On a fresh install, choose "Use your own API key" on the first screen to reach the same fields. If your version labels a field differently, confirm in the Cline settings screen.

| field | value |
|---|---|
| API Provider | `OpenAI Compatible` |
| Base URL | `https://gateway.rafikiai.io/v1` |
| API Key | your Rafiki AI key |
| Model | `rafiki-fast` (or `rafiki-pro`) |

The model field takes the tier name exactly as written, without a provider prefix. The tiers are the same as in the CLI: `rafiki-fast` for everyday work, and `rafiki-pro`, which uses more credits per token, for longer tasks.

Optional fields in the Model Configuration section of the same screen (labels as in Cline 4.1.17):

| field | suggested value |
|---|---|
| Context Window size | `128000` |
| Max Output Tokens | `16384` |
| Supports Images | off |
| Input Price and Output Price | leave empty or zero; Cline's cost display cannot reflect Rafiki AI credits; use the Rafiki AI console for spend |

Leave any Azure identity option unchecked.

## Check it works

Ask Cline something small ("summarize this file") and check the key's page in the Rafiki AI console: the request appears under the key you used. If Cline reports an authentication error, the key was pasted with extra whitespace or has been revoked; if it reports a budget error, see [Headless and CI, budget exhaustion](./headless-and-ci.md#budget-exhaustion).

## Notes

- Cline sends its own system prompt and tool definitions; it does not read your `AGENTS.md`. Put the same conventions in Cline rules (for example a `.clinerules` file at the project root) if you want parity with the CLI.
- Other tools with an OpenAI compatible provider setting work the same way: base URL, key, tier name. Aider, and the full Rafiki Code agent in Zed and JetBrains IDEs through ACP, are covered on [Using Rafiki Code from your editor](./ide.md).
