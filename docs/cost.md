# What a task costs

Rafiki Code shows what a task is costing while it runs, what it cost when it ends, and what your account was charged over the last days. Amounts are in USD, the unit your Rafiki AI account keeps its credits in and the one `rafikicode whoami` prints.

Two kinds of figure appear, and the wording keeps them apart:

- **Measured**: token counts (the gateway reports them with every answer), the credits read from your account when the task started, and everything `rafikicode usage` prints (the amounts your account was charged).
- **Estimates**: every amount shown during and right after a task. The terminal multiplies the token counts by the gateway's price list. Your account is charged by the gateway from its own figures, a little later, and the two can differ: when a request is answered by another tier after a failure, when the provider writes to its cache, and by rounding. These amounts always read `about ... (estimate)`.

## While a task runs

In the terminal interface, the right side of the prompt row shows the tier in use, the estimated spend of the task so far and the credits left:

```text
fast · about 0.0312 USD spent (estimate) · about 12.37 USD of credits left
```

A task is one session, from its first request to its last. Calls made by subagents started for the task are counted. The credits figure is the balance read from the Rafiki AI console when the session was opened, minus what the task is estimated to have spent since. The balance and the price list are read once per task, not per request.

The sidebar has the same figures in a `Cost` block, with the tier of each turn so far (`Tiers: fast, fast, pro`) and what caching saved.

The line needs a terminal at least 100 columns wide; the sidebar block has no such limit.

## Before a tier change

When you pick another tier for the next turn (`/models`), the line leads with the new tier and an estimate for a turn like the last one on that tier, before you send anything:

```text
next turn on pro: about 0.0450 USD (estimate) · fast · about 0.0312 USD spent (estimate) · about 12.37 USD of credits left
```

The terminal never moves a task to another tier by itself.

## After a task

`rafikicode run` prints one line on standard error after the answer, and the terminal interface prints the same line when you quit a session:

```text
Task cost: tiers fast, fast, pro · about 0.0312 USD (estimate) · caching saved about 0.0101 USD · about 12.37 USD of credits left
```

- `tiers`: the tier of each turn, in order. A long task is folded (`fast x12, pro x3`).
- `caching saved`: what the same input tokens would have cost at the full input price, minus the estimate. `caching saved nothing yet` means the provider wrote to its cache and nothing has read from it so far.
- `rafikicode run --format json` prints no such line.

When the gateway does not send its price list, no amount is shown. The line gives token counts instead:

```text
Task cost: tier fast · cost unknown, the gateway sent no price list (10,000 input and 2,000 output tokens)
```

When the Rafiki AI console cannot be reached, or the key has no view of the account, the credits figure is left out.

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
| `X-Rafiki-Tier` | `fast` or `pro`: the tier the request is made on |
| `X-Rafiki-Escalation` | `0` from the terminal: it never retries a task on another tier by itself |
