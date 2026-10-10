# Plan: Rafiki Max for everyone, real figures, and history in the sidebar

Branch `feature/max-real-metrics-history`, based on `review/cli-integration-2026-10-02` at `f3aa9ca7db`.

## Audit of the figures the terminal showed (before this branch)

| Figure | Where | Old source | Verdict | New source |
| --- | --- | --- | --- | --- |
| Context tokens | sidebar, prompt row, subagent footer | the last step's usage block (input, cache read, cache write, output, reasoning added up) | exact, but labelled as "tokens" with no hint it was one request plus its answer | the same usage block, split: tokens the last request sent, the cached part inside it, tokens received |
| Percentage used | sidebar, prompt row, subagent footer | the total above over the window of the tier that answered | exact share of something unnamed | tokens sent by the last request over the window of the tier that answered, named in the sidebar |
| Cached tokens | sidebar | cache reads of the last step | exact | unchanged, shown as "of them cached" |
| `$x spent` | sidebar, prompt row, subagent footer | the model price table of the provider (0 for every Rafiki tier, so hidden) | wrong for Rafiki tiers, never shown | removed |
| Spent so far | prompt row, sidebar `Cost` block | token counts times the gateway's price list | estimate | the key's spend (`/key/info`) less its spend when the session started |
| Credits left | prompt row, sidebar | the console balance read once when the session opened, minus the estimate | estimate | the console balance (`/api/v1/me`), read again after each answer |
| Caching saved | sidebar, run line | price list arithmetic | estimate | removed |
| Next turn on another tier | prompt row, sidebar | the last turn's tokens at the other tier's prices | estimate | removed; the tier and its credit rate are named instead |
| Key spent, key budget, share used | nowhere | none | not shown | `/key/info` spend and max_budget |
| Run summary (`Task cost:`) | `rafikicode run` | estimate, saving, credits estimate | estimate | `Task:` line: tier path, requests and tokens summed over every request (labelled "in all"), key spend after less before, key budget, console balance |
| `rafikicode usage` | command | console `/api/v1/usage` | exact (amounts charged) | unchanged |
| Exit line of the interface | after quitting | the estimated task line | estimate | the last status line of the session |

## Notes

- The gateway may count a request a moment after answering it. The interface reads the key again about 20 seconds after an answer; `run` reads it up to three times a second and a half apart and says so when the spend has still not moved.
- "This session" is a difference of two readings of the key: other use of the same key in the meantime is included, and the texts say "on this key".
