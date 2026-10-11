// The spend figures the terminal interface and rafikicode run show, from the
// gateway's own counts. Pure, no I/O: the readings come from account.ts
// (keyInfo for the key, balance for the wallet).
//
//   key spent, key budget   GET <gateway root>/key/info   spend, max_budget
//   spent this session      key spend now, less key spend when the session
//                           was opened in this interface (or the run started)
//   share of the budget     key spent over key budget
//   credits left            GET <console>/api/v1/me       wallet.balance_usd
//   credits not enforced    GET <console>/api/v1/me       wallet.billing_enforced
//
// An organisation whose billing is not enforced (internal and staff accounts)
// never stops at zero, so its balance is not shown: the credits line says so
// instead. A Console that does not send the field keeps the balance.
//
// Nothing here is worked out from a price list. A reading that failed keeps
// the last good one and is marked stale; a figure never read is not shown.
// The difference of key spend counts everything charged to the key in the
// meantime, so a second terminal using the same key adds to it; the texts say
// "on this key" for that reason.
import type { KeyInfo, Wallet } from "./account"

// What the credits line says when the organisation's billing is not enforced.
export const NOT_ENFORCED = "not enforced (internal account)"

export interface Reading {
  spend: number
  maxBudget: number | null
  at: number
}

export interface State {
  // Key spend when the session was opened (or the run started).
  start?: Reading
  // The latest good reading of the key.
  last?: Reading
  // Credits in the account, as the Console last said.
  balance?: { usd: number; at: number }
  // False when the Console says the organisation's work does not stop at
  // zero; undefined when it does not say.
  enforced?: boolean
  // True when the latest attempt to read failed: the figures are the last good ones.
  stale: boolean
}

export const empty = (): State => ({ stale: false })

export function reading(info: KeyInfo, at: number): Reading {
  return { spend: info.spend, maxBudget: info.maxBudget, at }
}

// The state after a refresh. A failed reading keeps the last good figures and
// marks them stale; the first good reading is also the start when none is set.
// The balance may be the figure alone or the wallet (account.ts), which also
// says whether billing is enforced.
export function update(
  state: State,
  input: { key?: Reading; balance?: number | Wallet; at: number; failed?: boolean },
): State {
  const next: State = { ...state, stale: Boolean(input.failed) }
  if (input.key) {
    next.last = input.key
    if (!next.start) next.start = input.key
  }
  const wallet = typeof input.balance === "number" ? { usd: input.balance } : input.balance
  if (wallet?.usd !== undefined) next.balance = { usd: wallet.usd, at: input.at }
  if (wallet?.enforced !== undefined) next.enforced = wallet.enforced
  return next
}

// True when the Console said reaching zero stops nothing for this account.
export function notEnforced(state: State): boolean {
  return state.enforced === false
}

// USD charged to the key since the start reading, never below zero (a budget
// reset makes the key's spend go back to zero).
export function sessionSpend(state: State): number | undefined {
  if (!state.start || !state.last) return undefined
  return Math.max(0, round(state.last.spend - state.start.spend))
}

// The share of the key's budget used: "5%", "<1%", "100%"; undefined without a cap.
export function budgetShare(reading: Reading | undefined): string | undefined {
  if (!reading || reading.maxBudget === null || reading.maxBudget <= 0) return undefined
  const share = (reading.spend / reading.maxBudget) * 100
  if (share <= 0) return "0%"
  if (share < 1) return "<1%"
  return `${Math.floor(share)}%`
}

const round = (value: number) => Math.round(value * 1e8) / 1e8

// 0.0312 USD below one USD, 12.37 USD above: enough digits for a single request.
export function usd(value: number): string {
  if (!Number.isFinite(value)) return "?"
  const abs = Math.abs(value)
  if (abs === 0) return "0 USD"
  if (abs < 0.00005) return "under 0.0001 USD"
  return `${value.toFixed(abs < 1 ? 4 : 2)} USD`
}

// "1.23 of 25.00 USD (4%)", or "1.23 USD, no budget cap".
export function keyText(reading: Reading): string {
  if (reading.maxBudget === null) return `${usd(reading.spend)}, no budget cap`
  const share = budgetShare(reading)
  return `${usd(reading.spend).replace(/ USD$/, "")} of ${usd(reading.maxBudget)}${share ? ` (${share})` : ""}`
}

// "12:04:31" in the local time of the terminal.
export function clock(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

// Where the figures stand: "from the gateway at 12:04:31", or why they are old.
export function freshness(state: State): string | undefined {
  if (!state.last) return state.stale ? "spend not available: the gateway did not answer" : undefined
  if (state.stale) return `not updated since ${clock(state.last.at)}: the gateway did not answer`
  return `from the gateway at ${clock(state.last.at)}`
}

// The sidebar lines, in order. Empty before the first reading.
export function lines(state: State): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = []
  const spent = sessionSpend(state)
  if (spent !== undefined) out.push({ label: "This session", value: usd(spent) })
  if (state.last) out.push({ label: "Key", value: keyText(state.last) })
  if (notEnforced(state)) out.push({ label: "Credits", value: NOT_ENFORCED })
  else if (state.balance) out.push({ label: "Credits left", value: usd(state.balance.usd) })
  return out
}

// The prompt row: tier, spent this session, share of the key budget. `room`
// is how many columns the line may take; shorter forms drop words first, then
// the budget, then everything but the tier. "(stale)" stays on every form
// that has a figure. For an account whose billing is not enforced the widest
// form ends with the credits line, the first part to go.
export function statusLine(input: { tier?: string; next?: string; state: State }, room = Number.POSITIVE_INFINITY): string {
  const { state } = input
  const spent = sessionSpend(state)
  const share = budgetShare(state.last)
  const mark = state.stale ? " (stale)" : ""
  const head = [input.next, input.tier].filter(Boolean)
  const credits = notEnforced(state) ? `Credits: ${NOT_ENFORCED}` : undefined
  const forms =
    spent === undefined
      ? [[...head, state.stale ? "spend not available" : "spend not read yet", credits], [...head, state.stale ? "spend not available" : "spend not read yet"], head]
      : [
          [...head, `${usd(spent)} this session${mark}`, share ? `key budget ${share} used` : `key ${usd(state.last!.spend)} spent`, credits],
          [...head, `${usd(spent)} this session${mark}`, share ? `key budget ${share} used` : `key ${usd(state.last!.spend)} spent`],
          [...head, `${usd(spent)}${mark}`, share ? `${share} of budget` : undefined],
          [...head, `${usd(spent)}${mark}`],
          head,
        ]
  return forms.map((parts) => parts.filter(Boolean).join(" · ")).find((text) => text.length <= room) ?? ""
}

// The line rafikicode run prints after a task.
// partial names why the run ended early ("stopped by SIGTERM", "ended with
// an error"): the line is then marked partial, since a request cut short may
// still be counted on the key after the line is printed.
export function runLine(input: {
  path: string
  requests: number
  sent: number
  received: number
  state: State
  pending?: boolean
  partial?: string
}): string {
  const count = (value: number) => Math.round(value).toLocaleString("en-US")
  const { state } = input
  const spent = sessionSpend(state)
  const parts = [
    input.partial ? `Task (partial, ${input.partial}): ${input.path}` : `Task: ${input.path}`,
    `${input.requests} ${input.requests === 1 ? "request" : "requests"}, ${count(input.sent)} tokens sent and ${count(input.received)} received in all`,
    spent === undefined
      ? "spend not available (the gateway did not answer)"
      : input.pending
        ? `${usd(spent)} counted on this key so far (the gateway had not counted the last requests yet)`
        : `${usd(spent)} spent on this key during the task`,
    state.last ? `key ${keyText(state.last)}` : undefined,
    notEnforced(state) ? `credits ${NOT_ENFORCED}` : state.balance ? `${usd(state.balance.usd)} of credits left` : undefined,
  ]
  return parts.filter(Boolean).join(" · ")
}
