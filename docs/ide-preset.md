# IDE preset: Cline

Cline is an open source coding agent extension for VS Code. It can talk to any OpenAI compatible endpoint, and the Rafiki gateway is one, so Cline can spend the same Rafiki Console wallet as `rafikicode`. Nothing is installed on the Rafiki side; this page is configuration only.

## What you need

- VS Code with the Cline extension installed from the marketplace.
- A Rafiki key. Any key kind works: the key `rafikicode login` stored for a terminal (see `rafikicode whoami` for its name, the value itself is in `~/.rafikicode/credentials`), or a server key created at [console.rafikiai.io/keys](https://console.rafikiai.io/keys). A dedicated key per editor is the tidier choice, since the Console shows spend per key.

## Settings

Open the Cline settings panel with the gear icon in the Cline view, then fill in the provider section as follows. Field names are as they appear in the current Cline documentation for the OpenAI Compatible provider; if your version labels a field differently, confirm in the Cline settings screen.

| field | value |
|---|---|
| API Provider | `OpenAI Compatible` |
| Base URL | `https://gateway.rafikiai.io/v1` |
| API Key | your Rafiki key |
| Model | `rafiki-fast` (or `rafiki-pro`, `rafiki-max`) |

The model field takes the alias exactly as written, without a provider prefix. The three aliases and their credit multipliers are the same as in the CLI: `rafiki-fast` 1x, `rafiki-pro` 4x, `rafiki-max` 15x.

Optional fields in the model configuration section of the same screen (confirm the exact labels in your Cline version):

| field | suggested value |
|---|---|
| Context Window size | `128000` |
| Max Output Tokens | `16384` |
| Computer Use, or tool and function calling | enabled, all three aliases support tool calls |
| Image Support | disabled |
| Input Price and Output Price | leave empty or zero; Cline's cost display cannot reflect Rafiki credits, use the Console for spend |

Leave any Azure identity option unchecked.

## Check it works

Ask Cline something small ("summarize this file") and watch the Console: the request appears under the key you used within a few seconds. If Cline reports an authentication error, the key was pasted with extra whitespace or has been revoked; if it reports a budget error, see [Headless and CI, budget exhaustion](./headless-and-ci.md#budget-exhaustion).

## Notes

- Cline sends its own system prompt and tool definitions; it does not read your `AGENTS.md`. Put the same conventions in Cline's custom instructions setting if you want parity with the CLI.
- Other editors and tools with an OpenAI compatible provider setting work the same way: base URL, key, alias. Only Cline is documented here because it is the preset we test.
