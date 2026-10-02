# Plan: cost display, tier headers and the usage command

Branch `feature/cost-display`, based on `v0.1.9`. Written before any code was
edited.

## Goal

A person never finishes a task surprised by what it cost.

1. While a task runs, the status line shows the tier in use, what the task has
   spent so far and the credits left in the account.
2. Before a tier change, the status line shows the new tier and an estimate
   for the next turn on it.
3. After the task, one line: the tier path, what was spent, what caching
   saved.
4. Every request to the gateway carries `X-Rafiki-Tier` and
   `X-Rafiki-Escalation` next to the existing `X-Rafiki-Surface`.
5. `rafikicode usage` prints the last 30 days by day and by tier.

## Terms

- Task: one session, from its first request to its last. A turn is one
  request of the person and the model calls that answer it, including the
  calls of subagents started for it.
- Tier: `fast`, `pro` or `max`, the suffix of the model alias a call was made
  on (`rafiki-fast`, `rafiki-pro`, `rafiki-max`).
- Tier path: the tier of each turn of the task, in order (`fast, fast, pro`).
- Credits: the balance of the Rafiki AI account. The account keeps it in USD
  and `rafikicode whoami` already prints it that way, so every figure here is
  in USD. No other unit is introduced.

## What exploration established

- The tiers are registered with a zero price (`packages/core/src/brand/brand.ts`),
  so the session cost the interface and `stats` show is always zero.
- Token counts per model call are already recorded on every assistant
  message, split into input, output, reasoning, cache read and cache write
  (`getUsage` in `packages/opencode/src/session/session.ts`). They come from
  the usage block of the gateway's answer.
- The gateway's answer carries no cost figure in its body. Cost has to be
  computed from token counts and a price list, so it is an estimate: the
  account is charged by the gateway from its own figures, later, and the two
  can differ (a request answered by another tier after a failure, cache
  writes, which the client library reports as plain input, rounding).
- The gateway serves its price list for the models a key may use at
  `GET /v1/model/info` (per token input, output, cache read and cache write
  prices per model alias). The public gateway host lets that path through.
- The account balance is served by the Rafiki AI console at `GET /api/v1/me`
  (`wallet.balance_usd`), which `whoami` and `doctor` already read.
- The console serves `GET /api/v1/usage?days=N`: totals and a split by model
  for the window. A call made on a tier alias is recorded under that alias,
  so the split by model answers "by tier" for the window. It has no split by
  day. See "Usage contract" below.
- Request headers: the provider options carry `X-Rafiki-Surface` for every
  model; a model entry may carry its own `headers`, merged into each request
  (`packages/opencode/src/session/llm/request.ts`).
- The terminal interface has plugin slots: `session_prompt_right` (the right
  side of the prompt row of a session) and `sidebar_content`. Built in
  plugins register there (`packages/tui/src/feature-plugins/builtins.ts`).
- On exit the interface prints the session title and how to continue
  (`packages/tui/src/app.tsx`).

## Design

### Headers

`Brand.provider.config()` gives each model entry
`headers: { "X-Rafiki-Tier": <tier>, "X-Rafiki-Escalation": "0" }`. The tier
is the one the request is made on, so a title or summary call made on the
small model says `fast` even when the task runs on `pro`. The escalation
value is `0` in the terminal client: it never retries a task on another tier
by itself. A service that drives the engine and does escalate sets the value
on its own relay (the attempt number), where the fact is known.

No upstream file changes: the model `headers` field already exists.

### Price list and balance (measured inputs)

`packages/core/src/brand/account.ts` (new):

- `prices(...)`: `GET <gateway root>/v1/model/info` with the key. Reads, per
  tier alias, `input_cost_per_token`, `output_cost_per_token`,
  `cache_read_input_token_cost` and `cache_creation_input_token_cost` from
  `litellm_params`, else from `model_info`. A tier with no input or output
  price is left out.
- `balance(...)`: `GET <console>/api/v1/me`, `wallet.balance_usd`.
- `snapshot(...)`: both, in parallel, each with a 5 second limit. Either
  half may be missing; nothing throws.
- Under `NODE_ENV=test` only loopback hosts are called, so no test run can
  reach a real service with a real credential.

Fetched once when a task starts (the session opens in the interface, or
`rafikicode run` starts), never per request.

### Accounting (pure)

`packages/core/src/brand/cost.ts` (new, no I/O). It lives in the brand layer
of `packages/core`, not under `packages/opencode/src/rafiki/`, because the
terminal interface package uses it and cannot import from `packages/opencode`:

- `tierOf(modelID)`.
- `price(tokens, tierPrice)`: charged cost and what the same tokens would
  have cost with every input token at the full input price. Reasoning tokens
  are priced as output. A missing cache price falls back to the input price.
- `summarize(calls, prices)`: tier path, spent, cache saving (uncached cost
  minus charged cost), token totals, the number of calls that could not be
  priced.
- `nextTurn(calls, tier, prices)`: the last turn's tokens priced on another
  tier.
- `remaining(balanceAtStart, spentNow, spentAtStart)`.
- The texts: status line, sidebar rows, the end of task line.

Every amount derived from the price list is labelled as an estimate in the
text. The remaining balance is "balance when the task started minus the
estimated spend" and is labelled the same way.

### Status line and sidebar

`packages/tui/src/feature-plugins/rafiki-cost.tsx` (new), a built in plugin:

- `session_prompt_right`: `pro · about 0.0312 USD spent (estimate) · about
  12.37 USD of credits left`. When the model selected for the next turn is on
  another tier than the last turn: `next turn on pro: about 0.0450 USD
  (estimate)` in front.
- `sidebar_content`: the same figures in rows, with the tier path, the cache
  saving and the balance when the task started.
- Subagent calls: counted from the message events of child sessions, and
  from a listing of the children when a session is opened and when a turn
  ends.
- The line takes the room the prompt row has: the longest form that fits is
  used, and before a tier change the new tier and its estimate are the last
  thing dropped.
- Without a price list the line shows the tier and token counts and says the
  cost is unknown. It never shows a zero as if it were a charge.

### End of task line

- `rafikicode run` (non interactive, default format): one line on standard
  error after the answer. `packages/opencode/src/rafiki/cost.ts` (new) reads
  the session's messages through the client the command already holds.
- The interface: the line is printed under the session lines on exit.

Form: `Task cost: tiers fast, fast, pro · about 0.0312 USD (estimate) ·
caching saved about 0.0101 USD`.

### `rafikicode usage`

`packages/opencode/src/rafiki/usage.ts` (new), registered next to `whoami`.
Options: `--days` (default 30, 1 to 365), `--json`.

Prints a by tier table for the window and a by day table. Amounts in USD.

## Usage contract

Endpoint: `GET <console>/api/v1/usage?days=30`, `Authorization: Bearer <key>`
(the key the terminal already holds: a browser sign in key or a server key).

Fields read today:

```json
{
  "object": "usage",
  "period": { "days": 30, "since": "2026-09-02T10:00:00.000Z" },
  "totals": { "calls": 0, "tokens_in": 0, "tokens_out": 0, "cost_usd": 0 },
  "by_model": [
    { "model": "rafiki-fast", "calls": 0, "tokens_in": 0, "tokens_out": 0, "cost_usd": 0 }
  ]
}
```

Field the command needs and the endpoint does not serve yet:

```json
{
  "by_day": [
    {
      "day": "2026-10-01",
      "calls": 12,
      "cost_usd": 0.0421,
      "by_tier": [
        { "tier": "fast", "calls": 9, "tokens_in": 120000, "tokens_out": 8000, "cost_usd": 0.0102 },
        { "tier": "pro", "calls": 3, "tokens_in": 40000, "tokens_out": 6000, "cost_usd": 0.0319 }
      ]
    }
  ]
}
```

- `day`: a UTC calendar day, `YYYY-MM-DD`, oldest first. Days without calls
  may be left out.
- `tier`: `fast`, `pro` or `max` for calls made on a tier alias, `other` for
  every other call charged to the same account.
- `cost_usd`: what the account was charged, as in `totals.cost_usd`.

Behaviour of the command:

- The endpoint answers 404: exit 1 with one line saying this console does
  not serve usage to the terminal, and where to read it in a browser.
- 401: the usual "sign in again" line, exit 2.
- 200 without `by_day`: the by tier table from `by_model`, then one line
  saying the daily figures are not served by this console yet. Exit 0.
- 200 with `by_day`: both tables.

Tests run against a local mock of both shapes.

## Files

New:

| File | Content |
|---|---|
| `packages/core/src/brand/cost.ts` | Accounting and texts. Pure. |
| `packages/core/src/brand/account.ts` | Price list and balance readers. |
| `packages/opencode/src/rafiki/cost.ts` | The end of task line for `run`. |
| `packages/opencode/src/rafiki/usage.ts` | The `usage` command. |
| `packages/tui/src/feature-plugins/rafiki-cost.tsx` | Status line and sidebar plugin. |
| `packages/core/test/brand/cost.test.ts` | Pricing, path, saving, texts. |
| `packages/opencode/test/rafiki/tier-headers.test.ts` | Headers on the wire against the mock gateway. |
| `packages/opencode/test/rafiki/cost.test.ts` | Price list and balance readers against mocks; the end of task line of a real `run`. |
| `packages/opencode/test/rafiki/usage.test.ts` | The command against the mock console, both shapes and the failures. |
| `packages/tui/test/feature-plugins/rafiki-cost.test.ts` | What the plugin derives from messages and a snapshot. |
| `CHANGELOG.md` | One line. |

Changed, fork owned:

| File | Change |
|---|---|
| `packages/core/src/brand/brand.ts` | Per model headers. |
| `packages/opencode/src/rafiki/contract.ts` | Header names, the usage path, the response types. |
| `packages/opencode/src/rafiki/cmd.ts` | Export the `usage` command. |
| `packages/opencode/test/brand/mock-gateway.mjs` | Record the two headers, serve `/v1/model/info`, optional cache token counts. |
| `packages/opencode/test/brand/mock-console.mjs` | Serve `/api/v1/usage`. |
| `docs/` | The status line, the end of task line and `usage`. |

Changed, upstream files (each a thin hook):

| File | Change |
|---|---|
| `packages/opencode/src/index.ts` | Register the `usage` command (one import name, one line). |
| `packages/opencode/src/cli/cmd/run.ts` | Start the tracker before the prompt, print the line after it (two calls). |
| `packages/tui/src/feature-plugins/builtins.ts` | Add the plugin to the list (two lines). |
| `packages/tui/src/feature-plugins/sidebar/context.tsx` | Hide the upstream "spent" row when it is zero, so it does not contradict the new rows. |
| `packages/tui/src/app.tsx` | Print the end of task line with the exit lines (one line). |
| `packages/opencode/test/cli/help/help-snapshots.test.ts` and its snapshot | The `usage` command. |

## Tests and checks

- Targeted: the new files above.
- Neighbours: `test/rafiki`, `test/brand`, `test/cli/help`, the TUI and core
  suites.
- `bun turbo typecheck --concurrency=3`, lint, `node docs/check.mjs`.
- The full suite of `packages/opencode` once, at the end.

## Risks

- The price list endpoint was read in the gateway's source and in the public
  host's route list; it was not called. When it does not answer, the display
  says the cost is unknown and shows tokens.
- An estimate can differ from the charge: a request answered by another tier
  after a failure is priced here at the tier that was asked for; cache writes
  are counted as plain input by the client library.
- One more line on standard error at the end of `rafikicode run`. Scripts that
  read standard output are not affected; `--format json` prints nothing new.

## Not in this branch

- No change to how requests are retried or which tier answers.
- The hidden third tier stays out of every list.
- No stored prices: nothing is written to the session database, and `stats`
  keeps reporting tokens.
- The interactive mode of `run` and the editor integration do not show the
  line.

## Open questions

1. Should the terminal show a credit unit other than USD? It shows USD, as
   the account does.
2. Should `--format json` of `run` carry a cost event?
3. Should the price list be served by the console next to the balance, so
   one call answers both?
