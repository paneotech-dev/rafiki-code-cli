# Plan: what the interface says about the model, the context and the tokens

Branch `fix/display-identity-usage`, based on `review/cli-integration-2026-10-02`
at `a3f5d6dbb7`. Written before any code was edited.

## What was reported

The owner, on Windows with 0.1.9 signed in with `rafikicode login` on
`rafiki-fast`: the assistant identity, the percentage used and the token
counts in the full screen interface are wrong.

## What was observed (0.1.9 from the public installer, and this line from source)

Both were driven on a pseudo terminal in a throwaway container against a
stand-in gateway that answers like the gateway does (OpenAI format chunks, a
usage block with `prompt_tokens` including the cached part,
`prompt_tokens_details.cached_tokens`, and for `rafiki-max`
`cache_creation_input_tokens`). A request whose text asks to escalate is
answered by `rafiki-pro` when `rafiki-fast` was asked for, the way the gateway
answers after a fallback (every streamed chunk names the group that answered).

| Where | Shown | True | Why |
| --- | --- | --- | --- |
| Prompt row | `Build · Rafiki Fast Rafiki` | `Build · Rafiki Fast` | the provider name is printed after a model name that already starts with it |
| Sidebar and prompt row | `24,942 tokens`, `19% used`, `24.9K (19%)` | 24,942 of a 1,000,000 token window, 2% | every tier is registered with a 128,000 token window (`packages/core/src/brand/brand.ts`); the upstream models of all three tiers take 1M |
| Sidebar | no cached figure | 20,480 of the 24,942 were read from the cache | the cached part is counted (once) but never shown |
| Message footer after a fallback | `Build · Rafiki Fast` | answered by Rafiki Pro | the message keeps the model that was asked for; the model the gateway names in its answer is dropped |
| Percentage after a fallback | measured against the window of the tier asked for | the window of the tier that answered | same cause |
| `run` cost line after a fallback | `tier fast · about 0.0014 USD` | pro prices: about 0.0205 USD | the tier path and the prices follow the model asked for |
| `rafiki-max` usage | cache writes counted as plain input | 8,000 of the input were cache writes | the client library reads `cached_tokens` only; the gateway sends the writes as `cache_creation_input_tokens` |
| Identity | `You are rafikicode, an interactive CLI tool ...` | Rafiki Code by PANEOTECH | the upstream line is rewritten word for word to the binary name; nothing says who makes the product or what to answer about the model |

`$0.00 spent` in the 0.1.9 sidebar is already gone on this line (the cost
display hides a zero).

## Per tier limits

The tiers and their upstreams on staging (`/opt/rafiki/litellm-config.yaml`,
read 2026-10-04): `rafiki-fast` is `deepseek/deepseek-flash`, `rafiki-pro` is
`openai/glm-5.3` (Z.ai), `rafiki-max` is `anthropic/claude-sonnet-5`. The
gateway's configuration sets no window for them, and the model map bundled
with its LiteLLM (read inside the gateway container with the library, not
through the gateway) knows only `claude-sonnet-5` (1,000,000 in, 128,000 out);
`deepseek-flash` and `glm-5.3` are not in it. So the gateway's model info
cannot be the source for two of the three tiers, and the client keeps a table.

| Tier | Window | Max output | Source, read 2026-10-04 |
| --- | ---: | ---: | --- |
| `rafiki-fast` | 1,000,000 | 384,000 | DeepSeek API docs, Models and Pricing (`deepseek-flash`: 1M context, 384K maximum output) |
| `rafiki-pro` | 1,000,000 | 128,000 | Z.ai docs, GLM-5.3 guide (1M context, 128K maximum output) |
| `rafiki-max` | 1,000,000 | 128,000 | Anthropic docs, Claude Sonnet 5 model page (1M context, 128K max output) |

The output a request asks for stays the request default of each tier (64,000
fast, 32,000 pro and max, `RAFIKICODE_MAX_OUTPUT_TOKENS` to change it); the
upstream maximum is recorded next to it and caps the override.

Compaction: until now a session was compacted when it neared the 128,000
token window. Moving the window to 1M would let a session grow to about
1M tokens before it is compacted, which multiplies the cost of every turn of
a long session. That is a spending decision for the owner, not a display fix,
so the point where a session is compacted stays near where it was: each tier
gets an input budget of 128,000 tokens (`limit.input`, which only the
compaction check reads), and the percentage is shown against the real
window.

## Changes

1. `packages/core/src/brand/brand.ts`: a table of the three tiers with window,
   upstream maximum output and the compaction budget, with the sources and
   the date. `limit.context` is the real window. The model label shown next
   to the provider name drops the provider name when the model name already
   starts with it (`Brand.provider.label`). The vendor name `PANEOTECH`.
2. Identity: `Brand.prompt` makes the upstream opening line say Rafiki Code,
   and the rafiki provider's prompt starts with an identity block: Rafiki
   Code by PANEOTECH, never another product or another company, and the
   honest answer about the model (the Rafiki tier that answers through the
   Rafiki AI gateway; the gateway chooses the model behind it and may move a
   request to the next tier; no model name is guessed or denied).
3. The tier that answered: `packages/opencode/src/session/llm/ai-sdk.ts`
   passes the model the answer names (and `X-Rafiki-Model` when the gateway
   sends it) in the step metadata; `packages/opencode/src/rafiki/served.ts`
   decides, for the rafiki provider only, whether another tier answered, and
   the processor records that tier on the assistant message. The context
   percentage, the message footer, the tier path and the cost estimate then
   follow the tier that answered. The message footer says
   `Rafiki Pro (asked for Rafiki Fast)`, and `run` prints a second header
   line naming the tier that answered.
4. Usage: cache writes the gateway reports (`cache_creation_input_tokens`,
   `prompt_tokens_details.cache_creation_tokens`) are read into
   `cache.write`; they are already inside `prompt_tokens`, so they are taken
   out of plain input once, not added.
5. Display: one pure function (`packages/core/src/brand/context.ts`) gives the
   context figure for the sidebar, the prompt row and the subagent footer:
   tokens in the context, the cached part, the window and the percentage
   (`<1%` for a non zero share under one per cent, never `0%`). The sidebar
   shows the cached part on a line of its own and the window it is measured
   against.

## Tests

- `packages/core/test/brand/context.test.ts`: the computation (no double
  counting, cached shown once, percentage of the right window, `<1%`).
- `packages/opencode/test/rafiki/served.test.ts`: the served tier decision
  (same tier, another tier, a model name that is not a tier, another
  provider, the header winning over the body).
- `packages/opencode/test/brand/display-limits.test.ts`: the per tier limits
  and the identity text in the system prompt.
- `packages/opencode/test/rafiki/display-run.test.ts`: `rafikicode run`
  against a stand-in gateway, once on fast and once with a fallback to pro:
  the printed headers and cost line, the tokens recorded on the message and
  the identity the stand-in received.

Upstream files touched are recorded in `script/upstream.json` and the table
in `docs/upstream.md` is regenerated.
