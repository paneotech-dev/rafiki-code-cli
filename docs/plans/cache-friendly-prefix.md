# Plan: a stable request prefix and a cache marker

Branch `feature/cache-friendly-prefix`, based on `v0.1.9`. Written before any
code was edited.

## Goal

Every request the CLI sends to the gateway starts with the same bytes as the
request before it in the same task, so the provider can reuse its prompt
cache: the system prompt, then the project instructions, then the repository
context, with the tool definitions unchanged next to them, and the
conversation last. A cache marker sits at the end of that stable part.
Nothing that changes on its own (a date, a time, a random id) is inside it.

## What the CLI sends today

Measured on `v0.1.9` by running one task (`rafikicode run`, one tool call,
two model requests) against a local mock gateway and saving the raw request
bodies. Provider `rafiki`, package `@ai-sdk/openai-compatible`, endpoint
`/v1/chat/completions`.

- Body keys in order: `model`, `max_tokens`, `messages`, `tools`,
  `tool_choice`, `stream`, `stream_options`. `messages[0]` is one system
  message holding everything; the conversation follows; `tools` is a
  separate field after the messages.
- Order inside the system message: the system prompt, the environment block
  (model name, working directory, git yes or no, platform, **today's date**),
  the project references, the project instructions (`AGENTS.md`), the house
  style, the skills list.
- The two requests of the task carry the same system message and the same
  `tools` value, byte for byte. Tool definitions are already sorted by name
  (`session/llm/request.ts`).
- No cache marker is sent on any tier. The marker code in
  `provider/transform.ts` (`applyCaching`) only runs when the provider or the
  model id names Anthropic or Claude; the gateway's tier names do not.
- The date sits about 9,000 characters into a 20,500 character system
  message. When the date changes, everything after it (the project
  instructions, the skills list) stops matching what a provider cached.
- Session ids travel in headers (`x-session-affinity`, `X-Session-Id`), not
  in the body.

So upstream already gives a deterministic prefix within a task. Missing: a
marker for the gateway's tiers, the date outside the stable part, and the
project instructions ahead of the repository context.

## Changes

New file `packages/opencode/src/rafiki/cache-prefix.ts`, which holds the
logic:

- `order(parts)`: the system text in the stable order: project
  instructions, then the repository context (environment block, project
  references), then MCP instructions and the skills list. The system prompt
  itself is already put first by `session/llm/request.ts`.
- `volatile()`: the one line that changes by itself (today's date), as a
  separate system message that follows the stable one.
- `mark(messages, model)`: for the gateway provider, on the tiers that take a
  marker, sets `cache_control: {"type": "ephemeral"}` on the last stable
  system message and, as upstream does for Claude models, on the last two
  conversation messages, so the growing conversation is reused as well.
- Which tiers take a marker: a list in the brand layer
  (`packages/core/src/brand/brand.ts`), default `rafiki-max`, changed with
  `RAFIKICODE_CACHE_MARKERS` (`all`, `off`, or tier names separated by
  commas). The other tiers are served by providers that cache a repeated
  prefix by themselves and need no marker; the gateway hands an unknown
  message field through to some of them, which is why they get none by
  default.

Upstream files touched, each by a few lines:

| File | Change |
|---|---|
| `packages/opencode/src/session/system.ts` | The environment block no longer holds the date line. |
| `packages/opencode/src/session/prompt.ts` | The system parts are ordered by `CachePrefix.order` instead of the inline array. |
| `packages/opencode/src/session/llm/request.ts` | The volatile system message is appended after the stable one. |
| `packages/opencode/src/provider/transform.ts` | `message()` calls `CachePrefix.mark` after the upstream marker step. |

Fork files touched: `packages/core/src/brand/brand.ts` (the tier list and the
environment variable name), `packages/opencode/test/brand/mock-gateway.mjs`
(an option to keep raw request bodies), `docs/configuration.md` (the
variable), `CHANGELOG.md` (new).

## Tests

`packages/opencode/test/rafiki/cache-prefix.test.ts`:

- One task against the mock gateway with a tool call, on a marked tier: the
  two consecutive requests share the stable prefix byte for byte (the raw
  bytes of the body up to the end of the marked system message, and the
  serialized `tools` value); the marker is on that system message and on no
  earlier byte; the stable prefix holds no date in any common format and no
  session, message or call id; the date is in the message after the marker;
  the second request's conversation extends the first's.
- The same task on an unmarked tier: the same prefix checks, no marker in
  the body.
- `RAFIKICODE_CACHE_MARKERS=off` and `=all`.
- Unit tests of `order`, `volatile` and `mark` (marker placement with one
  and with several system messages, tool messages, parts that cannot carry
  one).

Neighbouring suites run with it: `test/session`, `test/provider`,
`test/brand`, `test/rafiki`. Then the full suite once.

## Risks

- Two system messages instead of one. Chat completion endpoints accept
  several system messages; the mock cannot prove a given provider does. The
  second message is one short line.
- The marker is a message level `cache_control` field, which is what the
  SDK emits for a system message. Whether the gateway forwards it for every
  tier was read from its source, not measured with live calls, hence the
  narrow default list and the switch.
- The date moves by a few thousand characters. Agents that are given their
  own prompt get it in the same place as everyone else.
- A change to upstream's prompt assembly can undo the order. The test fails
  when it does.

## Not in this branch

- No change to how the conversation itself is built or compacted.
- No change to retry or stream handling.
- No change to the request body's key order: the provider renders tools and
  system text in its own order, and the marker follows that order.
