// The one line rafikicode run prints after a task: tier path, requests and
// tokens as the gateway reported them, what the key spent during the task by
// the gateway's own count, the key's budget, and the credits left in the
// account. Token counts are summed over every request of the task (each step
// of each answer, subagents included) and the line says so. The spend is the
// key's spend at the end less its spend at the start (/key/info), never a
// price list estimate (core/brand/meter.ts).
import * as Account from "@opencode-ai/core/brand/account"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Cost from "@opencode-ai/core/brand/cost"
import * as Meter from "@opencode-ai/core/brand/meter"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { UI } from "@/cli/ui"
import { isRound } from "./verify"

// Subagents of subagents are followed this deep.
const DEPTH = 3

type Item = { info: Cost.MessageLike; parts?: readonly unknown[] }

export interface Collected {
  calls: Cost.Call[]
  // One entry per request: the tokens of each step-finish part.
  steps: Cost.Tokens[]
}

async function itemsOf(client: OpencodeClient, sessionID: string): Promise<Item[]> {
  const result = await client.session.messages({ sessionID })
  return (result.data ?? []) as unknown as Item[]
}

export function stepsOf(items: readonly Item[]): Cost.Tokens[] {
  return items.flatMap((item) =>
    item.info.role === "assistant"
      ? (item.parts ?? []).flatMap((part) => {
          const value = part as { type?: string; tokens?: Partial<Cost.Tokens> }
          return value.type === "step-finish" ? [Cost.tokens(value.tokens)] : []
        })
      : [],
  )
}

// A fix round of the verify step (rafiki/verify.ts) or of the review pass
// (rafiki/review.ts) counts as part of the turn it follows, so the tier path names the turn once.
export function withVerifyRounds(items: readonly Item[]): Cost.MessageLike[] {
  const origin = new Map<string, string>()
  let last: string | undefined
  for (const item of items) {
    if (item.info.role !== "user") continue
    const round = isRound((item.parts ?? []) as { type: string; metadata?: Record<string, unknown> }[])
    if (!round || !last) last = item.info.id
    origin.set(item.info.id, last)
  }
  return items.map((item) =>
    item.info.role === "assistant" && item.info.parentID && origin.has(item.info.parentID)
      ? { ...item.info, parentID: origin.get(item.info.parentID) }
      : item.info,
  )
}

// Every model call of a task, and every request: the session's own and those
// of the subagent sessions started under it.
export async function collect(client: OpencodeClient, sessionID: string): Promise<Collected> {
  const own = await itemsOf(client, sessionID)
  const calls = Cost.callsOf(withVerifyRounds(own), true)
  const steps = stepsOf(own)
  const walk = async (parent: string, depth: number): Promise<void> => {
    if (depth > DEPTH) return
    const children = (await client.session.children({ sessionID: parent })).data ?? []
    for (const child of children) {
      const items = await itemsOf(client, child.id)
      calls.push(
        ...Cost.callsOf(
          items.map((item) => item.info),
          false,
        ),
      )
      steps.push(...stepsOf(items))
      await walk(child.id, depth + 1)
    }
  }
  await walk(sessionID, 1)
  return { calls, steps }
}

// The line for a task's requests and the meter readings around it.
export function line(collected: Collected, state: Meter.State, pending = false, partial?: string): string | undefined {
  const summary = Cost.summarize(collected.calls)
  if (summary.path.length === 0) return undefined
  const steps = collected.steps.filter((step) => Cost.total(step) > 0)
  const sent = steps.reduce((sum, step) => sum + step.input + step.cache.read + step.cache.write, 0)
  const received = steps.reduce((sum, step) => sum + step.output + step.reasoning, 0)
  return Meter.runLine({
    path: `${summary.path.length === 1 ? "tier" : "tiers"} ${Cost.pathText(summary.path)}`,
    requests: steps.length,
    sent,
    received,
    state,
    pending,
    partial,
  })
}

// The usage of one request as the JSON output of rafikicode run gives it:
// plain input (the cached part taken out), output, reasoning, and the cached
// input read and written.
export function usageOf(tokens: Partial<Cost.Tokens> | undefined) {
  const value = Cost.tokens(tokens)
  return {
    input: value.input,
    output: value.output,
    reasoning: value.reasoning,
    cache_read: value.cache.read,
    cache_write: value.cache.write,
  }
}

// The cost fields of a step_finish event. A step of the gateway provider
// costs what the gateway counted, when it put the figure in the usage block
// (rafiki/served.ts); a step of another provider costs what its price list
// gives. No figure is null with cost_source "unknown", never 0: the Rafiki
// tiers have no local price list, and the key's spend in the task event is
// the real total.
export function stepCostFields(input: { cost: number | undefined; providerID: string | undefined }) {
  const cost = typeof input.cost === "number" && Number.isFinite(input.cost) && input.cost > 0 ? input.cost : undefined
  if (cost === undefined) return { cost: null, cost_source: "unknown" as const }
  return { cost, cost_source: input.providerID === undefined || input.providerID === Brand.provider.id ? ("gateway" as const) : ("price_list" as const) }
}

export interface Measured {
  collected: Collected
  state: Meter.State
  pending: boolean
  partial?: string
}

// The task event of the JSON output, from the same figures as the line:
// the tiers, the requests and their usage, and the key's spend difference
// read from the gateway before and after the task (null when it could not be
// read). Undefined when the task made no call on a Rafiki tier, as the line.
export function taskEvent(measured: Measured) {
  const { collected, state } = measured
  const summary = Cost.summarize(collected.calls)
  if (summary.path.length === 0) return undefined
  const steps = collected.steps.filter((step) => Cost.total(step) > 0)
  const usage = steps.map((step) => usageOf(step)).reduce(
    (sum, step) => ({
      input: sum.input + step.input,
      output: sum.output + step.output,
      reasoning: sum.reasoning + step.reasoning,
      cache_read: sum.cache_read + step.cache_read,
      cache_write: sum.cache_write + step.cache_write,
    }),
    usageOf(undefined),
  )
  const spend = Meter.sessionSpend(state)
  return {
    tiers: summary.path,
    requests: steps.length,
    usage,
    cost: spend ?? null,
    cost_source: spend === undefined ? ("unknown" as const) : ("key_spend" as const),
    pending: measured.pending,
    partial: measured.partial ?? null,
    key: state.last ? { spend: state.last.spend, max_budget: state.last.maxBudget } : null,
    credits: Meter.notEnforced(state) ? { not_enforced: true } : state.balance ? { usd: state.balance.usd } : null,
  }
}

type Read = () => Promise<Account.KeyInfoResult>
type Balance = () => Promise<number | Account.Wallet | undefined>

function defaultBalance() {
  const from = Account.source()
  return from ? Account.wallet(from) : Promise.resolve(undefined)
}

const settle = (promise: Promise<Account.KeyInfoResult>, now: () => number) =>
  promise.catch((): Account.KeyInfoResult => ({ ok: false, at: now() }))

// Started before the first request of a run: reads the key's spend in the
// background. text() reads it again after the task, with the credits left,
// and builds the line; report() prints it, never fails the run, and prints
// nothing when the task made no call on a Rafiki tier. The gateway may count
// a request a moment after answering it: when the key's spend has not moved
// although requests were answered, it is read up to `retries` more times,
// then the line says the last requests may not be counted yet.
export function tracker(
  options: { read?: Read; balance?: Balance; now?: () => number; retries?: number; retryMs?: number } = {},
) {
  const now = options.now ?? Date.now
  const read: Read = options.read ?? (() => Account.keyInfo())
  const balance: Balance = options.balance ?? defaultBalance
  const start = settle(read(), now)
  let reported = false
  return {
    // partial: why the run ended early (a signal, an error). The line is
    // still printed, from the key's spend as the gateway reports it, and
    // marked partial.
    // verify: the outcome of the verify step (rafiki/verify.ts), added at the end of the line.
    async text(client: OpencodeClient, sessionID: string, partial?: string, verify?: string) {
      const text = await this.measure(client, sessionID, partial)
      return text && verify ? `${text} · ${verify}` : text
    },
    async measure(client: OpencodeClient, sessionID: string, partial?: string) {
      const measured = await this.measured(client, sessionID, partial)
      return line(measured.collected, measured.state, measured.pending, measured.partial)
    },
    async measured(client: OpencodeClient, sessionID: string, partial?: string): Promise<Measured> {
      const collected = await collect(client, sessionID)
      const answered = collected.steps.some((step) => Cost.total(step) > 0)
      const [first, credits] = await Promise.all([start, balance().catch(() => undefined)])
      let state = Meter.update(Meter.empty(), { balance: credits, at: now() })
      if (!first.ok) return { collected, state: { ...state, stale: true }, pending: false, partial }
      state = Meter.update(state, { key: Meter.reading(first.info, first.at), at: first.at })
      let pending = false
      for (let attempt = 0; ; attempt++) {
        const end = await settle(read(), now)
        if (!end.ok) {
          state = Meter.update(state, { failed: true, at: now() })
          break
        }
        state = Meter.update(state, { key: Meter.reading(end.info, end.at), at: end.at })
        if (!answered || end.info.spend > first.info.spend) break
        if (attempt >= (options.retries ?? 2)) {
          pending = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? 1500))
      }
      return { collected, state, pending, partial }
    },
    // Prints the line once per run, however the run ends.
    async report(client: OpencodeClient, sessionID: string, partial?: string, verify?: string) {
      if (reported) return
      reported = true
      try {
        const text = await this.text(client, sessionID, partial, verify)
        if (text) UI.println(UI.Style.TEXT_DIM + text + UI.Style.TEXT_NORMAL)
      } catch {
        // The answer was already printed; a missing line is not an error.
      }
    },
    // The JSON output's counterpart of report(): the task event, once per run.
    async event(client: OpencodeClient, sessionID: string, partial?: string) {
      if (reported) return undefined
      reported = true
      try {
        return taskEvent(await this.measured(client, sessionID, partial))
      } catch {
        return undefined
      }
    },
  }
}
