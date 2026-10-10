// The one line rafikicode run prints after a task: tier path, requests and
// tokens as the gateway reported them, what the key spent during the task by
// the gateway's own count, the key's budget, and the credits left in the
// account. Token counts are summed over every request of the task (each step
// of each answer, subagents included) and the line says so. The spend is the
// key's spend at the end less its spend at the start (/key/info), never a
// price list estimate (core/brand/meter.ts).
import * as Account from "@opencode-ai/core/brand/account"
import * as Cost from "@opencode-ai/core/brand/cost"
import * as Meter from "@opencode-ai/core/brand/meter"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { UI } from "@/cli/ui"

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

// Every model call of a task, and every request: the session's own and those
// of the subagent sessions started under it.
export async function collect(client: OpencodeClient, sessionID: string): Promise<Collected> {
  const own = await itemsOf(client, sessionID)
  const calls = Cost.callsOf(
    own.map((item) => item.info),
    true,
  )
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
export function line(collected: Collected, state: Meter.State, pending = false): string | undefined {
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
  })
}

type Read = () => Promise<Account.KeyInfoResult>
type Balance = () => Promise<number | undefined>

function defaultBalance() {
  const from = Account.source()
  return from ? Account.balance(from) : Promise.resolve(undefined)
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
  return {
    async text(client: OpencodeClient, sessionID: string) {
      const collected = await collect(client, sessionID)
      const answered = collected.steps.some((step) => Cost.total(step) > 0)
      const [first, credits] = await Promise.all([start, balance().catch(() => undefined)])
      let state = Meter.update(Meter.empty(), { balance: credits, at: now() })
      if (!first.ok) return line(collected, { ...state, stale: true })
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
      return line(collected, state, pending)
    },
    async report(client: OpencodeClient, sessionID: string) {
      try {
        const text = await this.text(client, sessionID)
        if (text) UI.println(UI.Style.TEXT_DIM + text + UI.Style.TEXT_NORMAL)
      } catch {
        // The answer was already printed; a missing line is not an error.
      }
    },
  }
}
