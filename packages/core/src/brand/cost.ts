// What a task costs, as far as this client can tell: token counts the gateway
// reported, priced with the gateway's own price list. Pure functions, no I/O.
//
// Two kinds of figure, kept apart on purpose:
//   measured   token counts (the usage block of each gateway answer) and the
//              balance read from the account when the task started
//   estimates  every USD amount derived from tokens and the price list. The
//              account is charged by the gateway from its own figures, later,
//              and that charge can differ (another tier answered after a
//              failure, cache writes reported as plain input, rounding).
// Every text built here says "about" and "estimate" for the second kind and
// never prints a zero as if it were a charge.
//
// Unit: USD, the unit the Rafiki AI account keeps its credits in and the one
// rafikicode whoami prints. No other unit is introduced here.

export const TIERS = ["fast", "pro", "max"] as const
export type Tier = (typeof TIERS)[number]

const ALIAS = /^rafiki-(fast|pro|max)$/

// The tier of a gateway alias: rafiki-fast is fast. Undefined for any other model.
export function tierOf(model: string | undefined): Tier | undefined {
  return (model ? ALIAS.exec(model)?.[1] : undefined) as Tier | undefined
}

export interface Tokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

// USD per million tokens. A missing cache price means the gateway lists none:
// those tokens are priced as plain input.
export interface TierPrice {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export type Prices = Partial<Record<Tier, TierPrice>>

// One model call: an assistant message of the task's session or of a
// subagent session started for it.
export interface Call {
  id: string
  // False for a call made in a subagent session.
  root: boolean
  // The request of the person this call answers (root calls only).
  turn?: string
  model: string
  tokens: Tokens
  // When the call started, in milliseconds.
  time: number
}

// What this file needs of a session message, so it does not depend on the
// client library's types.
export interface MessageLike {
  id: string
  role: string
  parentID?: string
  modelID?: string
  tokens?: Partial<Tokens>
  time: { created: number }
}

// The model calls among a session's messages: its assistant messages.
export function callsOf(messages: readonly MessageLike[], root: boolean): Call[] {
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? [
          {
            id: message.id,
            root,
            turn: root ? message.parentID : undefined,
            model: message.modelID ?? "",
            tokens: tokens(message.tokens),
            time: message.time.created,
          },
        ]
      : [],
  )
}

const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0)

export function tokens(value: Partial<Tokens> | undefined): Tokens {
  return {
    input: finite(value?.input),
    output: finite(value?.output),
    reasoning: finite(value?.reasoning),
    cache: { read: finite(value?.cache?.read), write: finite(value?.cache?.write) },
  }
}

function add(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cache: { read: a.cache.read + b.cache.read, write: a.cache.write + b.cache.write },
  }
}

export function total(value: Tokens) {
  return value.input + value.output + value.reasoning + value.cache.read + value.cache.write
}

const NONE: Tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

// The estimated charge for some tokens on one tier, and what the same tokens
// would have cost with every input token at the full input price. Reasoning
// tokens are priced as output.
export function price(value: Tokens, rate: TierPrice) {
  const out = (value.output + value.reasoning) * rate.output
  const charged =
    value.input * rate.input +
    value.cache.read * (rate.cacheRead ?? rate.input) +
    value.cache.write * (rate.cacheWrite ?? rate.input) +
    out
  const uncached = (value.input + value.cache.read + value.cache.write) * rate.input + out
  return { charged: charged / 1_000_000, uncached: uncached / 1_000_000 }
}

export interface Summary {
  // The tier of each turn of the task, in order.
  path: Tier[]
  // The tier of the latest call of the task's own session.
  tier?: Tier
  // Estimated USD charged for the calls that could be priced.
  spent: number
  // Estimated USD the same calls would have cost without caching, minus spent.
  // Negative when cache writes cost more than they have saved so far.
  saved: number
  tokens: Tokens
  // Calls with tokens that were priced, and that could not be (no price for
  // the tier, or a model that is not a Rafiki tier).
  priced: number
  unpriced: number
}

export function summarize(calls: readonly Call[], prices: Prices | undefined): Summary {
  const ordered = [...calls].sort((a, b) => a.time - b.time)
  const path: Tier[] = []
  let turn: string | undefined
  let tier: Tier | undefined
  let spent = 0
  let uncached = 0
  let sum = NONE
  let priced = 0
  let unpriced = 0
  for (const call of ordered) {
    const callTier = tierOf(call.model)
    if (call.root && callTier) {
      // One entry per turn; a turn that moved tier half way lists both.
      if (call.turn !== turn || path.at(-1) !== callTier) path.push(callTier)
      turn = call.turn
      tier = callTier
    }
    if (total(call.tokens) === 0) continue
    sum = add(sum, call.tokens)
    const rate = callTier ? prices?.[callTier] : undefined
    if (!rate) {
      unpriced++
      continue
    }
    const cost = price(call.tokens, rate)
    spent += cost.charged
    uncached += cost.uncached
    priced++
  }
  return { path, tier, spent, saved: uncached - spent, tokens: sum, priced, unpriced }
}

// What a turn like the last one would cost on another tier: the tokens of the
// last turn (subagent calls made since it started included) at that tier's
// prices. Undefined without a last turn or without a price for the tier.
export function nextTurn(calls: readonly Call[], tier: Tier, prices: Prices | undefined): number | undefined {
  const rate = prices?.[tier]
  if (!rate) return undefined
  const root = calls.filter((call) => call.root && total(call.tokens) > 0).sort((a, b) => a.time - b.time)
  const last = root.at(-1)
  if (!last) return undefined
  const start = Math.min(...root.filter((call) => call.turn === last.turn).map((call) => call.time))
  const sum = calls
    .filter((call) => (call.root ? call.turn === last.turn : call.time >= start))
    .reduce((acc, call) => add(acc, call.tokens), NONE)
  return price(sum, rate).charged
}

// Credits left: the balance read when the task started, minus what the task
// is estimated to have spent since that reading.
export function remaining(start: { balance: number; spent: number } | undefined, spentNow: number): number | undefined {
  if (!start) return undefined
  return start.balance - Math.max(0, spentNow - start.spent)
}

// 0.0312 below one USD, 12.37 above: enough digits for a single call to show.
export function usd(value: number): string {
  if (!Number.isFinite(value)) return "?"
  const abs = Math.abs(value)
  if (abs === 0) return "0 USD"
  if (abs < 0.00005) return "under 0.0001 USD"
  return `${value.toFixed(abs < 1 ? 4 : 2)} USD`
}

// An estimated amount in a sentence: "about 0.0312 USD", or "under 0.0001 USD".
export function about(value: number): string {
  const text = usd(value)
  return text.startsWith("under") || text === "?" ? text : `about ${text}`
}

const count = (value: number) => Math.round(value).toLocaleString("en-US")

// fast, fast, pro. A long task is folded into runs: fast x12, pro x3.
export function pathText(path: readonly Tier[]): string {
  if (path.length <= 8) return path.join(", ")
  const runs: { tier: Tier; n: number }[] = []
  for (const tier of path) {
    const last = runs.at(-1)
    if (last?.tier === tier) last.n++
    else runs.push({ tier, n: 1 })
  }
  return runs.map((run) => (run.n > 1 ? `${run.tier} x${run.n}` : run.tier)).join(", ")
}

export function spentText(summary: Summary): string {
  if (summary.priced === 0 && summary.unpriced === 0) return "nothing spent yet"
  if (summary.priced === 0) return `cost unknown (${count(total(summary.tokens))} tokens)`
  const partial = summary.unpriced > 0 ? `, ${summary.unpriced} ${summary.unpriced === 1 ? "call" : "calls"} not priced` : ""
  return `${about(summary.spent)} spent (estimate${partial})`
}

export function savedText(summary: Summary): string | undefined {
  if (summary.priced === 0) return undefined
  if (summary.tokens.cache.read + summary.tokens.cache.write === 0) return "caching saved nothing"
  if (summary.saved <= 0) return "caching saved nothing yet"
  return `caching saved ${about(summary.saved)}`
}

export function leftText(left: number | undefined, summary: Summary): string | undefined {
  if (left === undefined) return undefined
  // Before anything is spent the figure is the balance as read, not an estimate.
  if (summary.priced === 0 && summary.unpriced === 0) return `${usd(left)} of credits`
  if (summary.priced === 0) return `${usd(left)} of credits when the task started`
  return `${about(left)} of credits left`
}

export interface Display {
  summary: Summary
  // Credits left (remaining()), when the balance was read.
  left?: number
  // The tier selected for the next turn and its estimate, when it differs
  // from the tier of the last turn.
  next?: { tier: Tier; estimate?: number }
}

// Everything the status line shows, from the task's calls, the price list,
// the balance reading and the model selected for the next turn.
export function display(input: {
  calls: readonly Call[]
  prices?: Prices
  // The balance read when the task started and what the task had already
  // spent at that moment (estimate).
  start?: { balance: number; spent: number }
  selected?: string
}): Display {
  const summary = summarize(input.calls, input.prices)
  const tier = tierOf(input.selected)
  return {
    summary,
    left: remaining(input.start, summary.spent),
    next: tier && summary.tier && tier !== summary.tier ? { tier, estimate: nextTurn(input.calls, tier, input.prices) } : undefined,
  }
}

export function nextText(next: Display["next"]): string | undefined {
  if (!next) return undefined
  if (next.estimate === undefined) return `next turn on ${next.tier}`
  return `next turn on ${next.tier}: ${about(next.estimate)} (estimate)`
}

// The status line while a task runs: tier, spent so far, credits left.
export function statusLine(input: Display): string {
  return [nextText(input.next), input.summary.tier, spentText(input.summary), leftText(input.left, input.summary)]
    .filter(Boolean)
    .join(" · ")
}

// The one line after a task: tier path, spent, cache saving.
export function taskLine(input: Display): string | undefined {
  const { summary } = input
  if (summary.path.length === 0) return undefined
  const cost =
    summary.priced === 0
      ? `cost unknown, the gateway sent no price list (${count(summary.tokens.input + summary.tokens.cache.read + summary.tokens.cache.write)} input and ${count(summary.tokens.output + summary.tokens.reasoning)} output tokens)`
      : `${about(summary.spent)} (estimate${summary.unpriced > 0 ? `, ${summary.unpriced} ${summary.unpriced === 1 ? "call" : "calls"} not priced` : ""})`
  const left = summary.priced > 0 && input.left !== undefined ? `${about(input.left)} of credits left` : undefined
  return [`Task cost: ${summary.path.length === 1 ? "tier" : "tiers"} ${pathText(summary.path)}`, cost, savedText(summary), left]
    .filter(Boolean)
    .join(" · ")
}

// The last end of task line a terminal interface built, printed with its exit
// lines. One process, one interface: a module value is enough.
let epilogueLine: string | undefined
export function remember(line: string | undefined) {
  epilogueLine = line
}
export function remembered() {
  return epilogueLine
}
// The remembered line as the interface prints it under its exit lines.
export function epilogue() {
  return epilogueLine ? `  ${epilogueLine}\n\n` : ""
}
