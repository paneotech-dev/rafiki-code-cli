// How large a session may grow before it is compacted, and when a single
// request is large enough to say so.
//
// compaction point  a session is compacted once its context reaches this many
//                   tokens (Brand.context.compactAt, 150000, on the Rafiki
//                   tiers), well before the model's window, because every turn
//                   resends the whole conversation. RAFIKICODE_COMPACT_AT wins
//                   over compaction.threshold in the config; 0 or off leaves
//                   only the window (the window less the output reserve).
//   large request   when the next request would send more than warn_at tokens
//                   (Brand.context.warnAt, 200000), one line suggests /compact
//                   or a new session, once until the session is under it again.
//                   RAFIKICODE_WARN_AT wins over compaction.warn_at; 0 or off
//                   turns it off.
import { Brand } from "@opencode-ai/core/brand/brand"

type Env = Record<string, string | undefined>
type Compaction = { threshold?: number; warn_at?: number } | undefined

// A token count from the environment: a number, "off" (0), or undefined when
// unset or unreadable. Thousands separators are accepted.
export function envTokens(name: string, env: Env = process.env): number | undefined {
  const value = env[name]?.trim().toLowerCase().replace(/[,_]/g, "")
  if (!value) return undefined
  if (["off", "false", "no"].includes(value)) return 0
  if (!/^\d+$/.test(value)) return undefined
  return Number(value)
}

// The compaction point in tokens, or undefined when only the window counts.
export function compactAt(input: { compaction: Compaction; providerID: string | undefined; env?: Env }) {
  const value =
    envTokens(Brand.env.compactAt, input.env) ??
    input.compaction?.threshold ??
    (input.providerID === Brand.provider.id ? Brand.context.compactAt : undefined)
  return value ? value : undefined
}

// The request size in tokens above which the line is shown, or undefined when off.
export function warnAt(input: { compaction: Compaction; env?: Env }) {
  const value = envTokens(Brand.env.warnAt, input.env) ?? input.compaction?.warn_at ?? Brand.context.warnAt
  return value ? value : undefined
}

const grouped = (value: number) => Math.round(value).toLocaleString("en-US")

export const PREFIX = "Large request:"
export const isWarning = (message: unknown) => typeof message === "string" && message.startsWith(PREFIX)
export const TITLE = `${Brand.product} context`

export const warningLine = (tokens: number) =>
  `${PREFIX} about ${grouped(tokens)} tokens. Run /compact or start a new session to make the next turns cheaper.`

// Sessions already warned and not back under the threshold since.
const warned = new Set<string>()

// Whether to show the line now: true the first time a session is over the
// threshold, false after that until it is under it again.
export function shouldWarn(sessionID: string, tokens: number, threshold: number | undefined) {
  if (threshold === undefined || tokens <= threshold) {
    warned.delete(sessionID)
    return false
  }
  if (warned.has(sessionID)) return false
  warned.add(sessionID)
  return true
}

// For tests.
export function reset() {
  warned.clear()
}
