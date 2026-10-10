# What a task costs

Rafiki Code shows what the last request sent, what your key has spent, and what your account was charged over the last days. Every figure comes from the gateway or the Rafiki AI console; none is worked out from a price list. Amounts are in USD, the unit your Rafiki AI account keeps its credits in and the one `rafikicode whoami` prints.

| Figure | Where it comes from |
|---|---|
| Tokens sent, cached, received | the usage block the gateway returns with each answer, for the tier that answered |
| Share of the window | tokens the last request sent, over the window of the tier that answered (1,000,000 on every tier) |
| Spent this session | the key's spend as the gateway counts it (`/key/info`), less its spend when the session started |
| Key spent and budget, share used | the key's spend and budget as the gateway reports them (`/key/info`) |
| Credits left | the balance of your account as the Rafiki AI console reports it (`/api/v1/me`) |
| `rafikicode usage` | the amounts the console recorded as charged |

## Context

The sidebar's `Context` block describes the last request of the session, not a sum over the session:

```text
Last request sent 24,530 tokens
20,480 of them cached
2% of the 1M window of Rafiki Fast
412 tokens received
```

The prompt row shows the same in short (`24.5K sent (2%)`). The tokens sent are everything the request carried (plain input, input read from the cache, input written to the cache), each counted once; the cached part is inside that figure. The share is of the window of the tier that answered.

In a long session the tokens sent can drop from one turn to the next: old, large tool outputs are replaced with a short note once enough of them have piled up. See [Long sessions: old tool output](configuration.md#long-sessions-old-tool-output).

## Spend

The right side of the prompt row shows the tier, what the key has spent since the session started, and the share of the key's budget used:

```text
fast · 0.0125 USD this session · key budget 4% used
```

The sidebar's `Spend` block has every figure:

```text
Tiers: fast, fast, pro
This session: 0.0125 USD
Key: 1.21 of 25.00 USD (4%)
Credits left: 12.40 USD
from the gateway at 12:04:31
```

The key's spend and budget are read from the gateway when the interface starts, when a session is opened, and after each answer has completed (once things settle, and once more about 20 seconds later, because the gateway may count a request a moment after answering it). They are never read while an answer is streaming, and reading never holds up the interface. The credits are read from the Rafiki AI console at the same moments.

- `This session` is the difference between two readings of the key, so anything else charged to the same key in the meantime (another terminal, an editor) is in it too.
- When a reading fails, the last figures stay on screen, the prompt row marks them `(stale)` and the sidebar says since when they have not been updated. A figure that was never read is not shown: before the first reading the prompt row says `spend not read yet`.
- A key without a budget shows its spend and `no budget cap`. Credits are left out when the console cannot be reached or the key has no view of the account.

When the prompt row has less room, the line is shortened rather than cut: first to `fast · 0.0125 USD · 4% of budget`, then to the tier and the amount, then to the tier alone.

## Before a tier change

When you pick another tier for the next turn (`/models`), the line leads with the new tier and its credit rate, before you send anything:

```text
next turn on pro (4x credits) · fast · 0.0125 USD this session · key budget 4% used
```

The terminal never moves a task to another tier by itself.

## When the gateway answers on another tier

When the tier you asked for cannot answer, the gateway answers on the next tier up (`rafiki-fast` on `rafiki-pro`). Rafiki Code reads the tier named in the answer and counts the request on that tier: the tier path and the context figure follow the tier that answered. The message footer in the terminal interface says so (`Build · Rafiki Pro (asked for Rafiki Fast)`), and `rafikicode run` prints a second header line:

```text
> build · rafiki-pro (rafiki-fast was asked for, the gateway answered on rafiki-pro)
```

Your next request is still made on the tier you chose.

## After a task

`rafikicode run` prints one line on standard error after the answer:

```text
Task: tiers fast, fast, pro · 3 requests, 61,000 tokens sent and 2,400 received in all · 0.0125 USD spent on this key during the task · key 1.21 of 25.00 USD (4%) · 12.40 USD of credits left
```

- `tiers`: the tier of each turn, in order. A long task is folded (`fast x12, pro x3`).
- `requests` and tokens: every request of the task, subagents included, added up, as the gateway reported them.
- The spend is the key's spend after the task less its spend before it. It includes the short request that names the session. If the gateway has not counted the requests yet after a few seconds, the line says so instead of showing a figure that is too low as if it were final. If the gateway cannot be asked, the line says `spend not available`.
- `rafikicode run --format json` prints no such line.

When you quit the terminal interface, it prints the last status line of the session under its exit lines.

## The last 30 days

```sh
rafikicode usage             # last 30 days
rafikicode usage --days 7    # 1 to 365
rafikicode usage --json      # the console's answer as JSON
```

```text
Usage of your Rafiki AI account, last 30 days (since 2026-09-02). Amounts are USD charged.

By tier
  Tier    Calls   Input tokens   Output tokens   Charged
  fast        9        120,000           8,000    0.0101
  pro         3         40,000           6,000    0.2000
  other       3          8,000           1,500    0.0420
  total      15        168,000          15,500    0.2521
  "other" is every call of the account that was not made on a Rafiki Code tier.

By day (UTC)
  Day          Calls     fast      pro    other   Charged
  2026-09-30       7   0.0051        -   0.0420    0.0471
  2026-10-01       8   0.0050   0.2000        -    0.2050
```

These are the amounts charged to your account, as the Rafiki AI console recorded them. The report covers the whole account: calls from other terminals, from editors and from the console itself are included.

If the console does not serve the daily figures, the command prints the by tier table and says so. Exit codes: 0 on success, 1 when the console has no usage route, 2 when the key is missing or no longer valid, 4 when the console cannot be reached.

## Request headers

Every request to the gateway carries three headers, so each line of your usage can be attributed:

| Header | Value |
|---|---|
| `X-Rafiki-Surface` | `cli`, or `ide` under an editor |
| `X-Rafiki-Tier` | `fast`, `pro` or `max`: the tier the request is made on |
| `X-Rafiki-Escalation` | `0` from the terminal: it never retries a task on another tier by itself |

The requests of a task also carry an `Idempotency-Key` header, which says whether a request is a repeat of one already sent. It is described in [the idempotency key contract](./contracts/idempotency-key.md).
