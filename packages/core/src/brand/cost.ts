// What a task did, as the gateway reported it: the tier of each turn and the
// token counts of each request. Pure functions, no I/O. Amounts of money are
// not worked out here: they come from the gateway's own count of what the key
// has spent (meter.ts), never from a price list.

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
  // True once the call has ended (completed, failed or was cut). A call that
  // ended without token counts reported no usage.
  done?: boolean
}

// What this file needs of a session message, so it does not depend on the
// client library's types.
export interface MessageLike {
  id: string
  role: string
  parentID?: string
  modelID?: string
  tokens?: Partial<Tokens>
  time: { created: number; completed?: number }
  error?: unknown
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
            done: Boolean(message.time.completed || message.error),
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

export interface Summary {
  // The tier of each turn of the task, in order.
  path: Tier[]
  // The tier of the latest call of the task's own session.
  tier?: Tier
  // Every token the gateway reported for the task's calls, added up.
  tokens: Tokens
  // Calls with token counts.
  reported: number
  // Calls that ended without token counts (a stream cut before its usage
  // block, a request that failed).
  unreported: number
}

export function summarize(calls: readonly Call[]): Summary {
  const ordered = [...calls].sort((a, b) => a.time - b.time)
  const path: Tier[] = []
  let turn: string | undefined
  let tier: Tier | undefined
  let sum = NONE
  let reported = 0
  let unreported = 0
  for (const call of ordered) {
    const callTier = tierOf(call.model)
    if (call.root && callTier) {
      // One entry per turn; a turn that moved tier half way lists both.
      if (call.turn !== turn || path.at(-1) !== callTier) path.push(callTier)
      turn = call.turn
      tier = callTier
    }
    if (total(call.tokens) === 0) {
      if (call.done) unreported++
      continue
    }
    sum = add(sum, call.tokens)
    reported++
  }
  return { path, tier, tokens: sum, reported, unreported }
}

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
