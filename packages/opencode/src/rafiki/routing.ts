// Which Rafiki tier a request goes to, by task, when the person has not
// pinned a tier.
//
// pinned         a tier given with the prompt (`rafikicode run --model`, the
//                tier shown in the terminal interface, an API client that
//                names one), `model` in the configuration, or an agent with a
//                model of its own. A pinned session keeps its tier for every
//                request; only an explicit /deep (or `run --deep`) moves a turn.
// cheap work     on an unpinned session, explore subagents, session titles and
//                compaction summaries go to rafiki-fast.
// escalation     a turn goes to rafiki-pro on a difficulty signal only:
//                  deep      /deep or `rafikicode run --deep`
//                  plan      the plan agent on a wide change
//                  failing   the same check failed twice in a row
//                  review    the /review step
//                never on the size of the context, and never to rafiki-max. A
//                session already on rafiki-pro or rafiki-max is not moved.
//                Before an escalated request over COMPACT_FIRST tokens the
//                session is compacted first (once per turn), and the next turn
//                goes back to the session's tier: the session's tier itself is
//                never changed.
//
// Each choice is logged (the debug log, "routing") and kept per assistant
// message, so `rafikicode run --format json` puts the tier and the reason on
// its step events. RAFIKICODE_ROUTING=off turns the whole thing off.
import { Brand } from "@opencode-ai/core/brand/brand"

export const FAST = "rafiki-fast"
export const PRO = "rafiki-pro"
// Context size above which an escalated request compacts the session first.
export const COMPACT_FIRST = 60_000

export const DEEP_DESCRIPTION = "send this message on Rafiki Pro, then go back to the session's tier"

export type Purpose = "turn" | "subagent" | "title" | "compaction"
export type Signal = "deep" | "plan" | "failing" | "review"

export interface Decision {
  tier: string
  reason: string
  // True when the request goes to a stronger tier than the session's.
  escalated: boolean
}

type Env = Record<string, string | undefined>

export function enabled(env: Env = process.env) {
  const value = env[Brand.env.routing]?.trim().toLowerCase()
  return !(value && ["0", "off", "false", "no"].includes(value))
}

const rafiki = (providerID: string | undefined) => providerID === Brand.provider.id
const strength = (tier: string) => (Brand.models as readonly string[]).indexOf(tier)

// Whether the latest prompt of a session named its tier. Recorded when the
// user message is created; a session with no prompt in this process (a
// subagent's, a resumed one) counts as unpinned.
const pins = new Map<string, boolean>()
export const pin = (sessionID: string, pinned: boolean) => void pins.set(sessionID, pinned)
export const pinned = (sessionID: string) => pins.get(sessionID) === true

// Signals asked for by a command (/deep, /review) for the session's current
// turn; cleared when the turn ends.
const requested = new Map<string, Signal>()
export const request = (sessionID: string, signal: Signal) => void requested.set(sessionID, signal)
export const requestedFor = (sessionID: string) => requested.get(sessionID)

// Turns that compacted before an escalated request already.
const compacted = new Set<string>()
export const markCompacted = (sessionID: string) => void compacted.add(sessionID)
export const compactedFor = (sessionID: string) => compacted.has(sessionID)

// The end of a turn: the signals and the compaction mark go, the next turn
// starts on the session's tier again.
export function endTurn(sessionID: string) {
  requested.delete(sessionID)
  compacted.delete(sessionID)
}

const WIDE =
  /\b(?:refactor\w*|migrat\w*|rewrit\w*|redesign\w*|re-architect\w*|architecture|across (?:the|all|every)\b|(?:every|all|each) (?:file|module|package|service|component|endpoint)s?\b|(?:whole|entire) (?:code ?base|project|repo\w*|app\w*)|codebase-wide|project-wide|repo-wide)/i
const PATH = /(?:^|[\s`'"(])(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,6}\b/gi

// A change wide enough for plan mode to escalate: words that name a change
// across the project, or five or more file paths.
export function wide(text: string) {
  if (WIDE.test(text)) return true
  return (text.match(PATH)?.length ?? 0) >= 5
}

// The reason line for a signal.
const reasons: Record<Signal, string> = {
  deep: "deep: asked for with /deep or --deep",
  plan: "plan: the plan agent on a wide change",
  failing: "failing: the same check failed twice in a row",
  review: "review: the review step",
}

// The tier for one request.
export function choose(input: {
  purpose: Purpose
  providerID: string | undefined
  // The session's tier (the user message's model).
  tier: string
  pinned: boolean
  signal?: Signal
  // For a subagent: its agent name.
  agent?: string
  env?: Env
}): Decision {
  const keep = (reason: string): Decision => ({ tier: input.tier, reason, escalated: false })
  if (!rafiki(input.providerID)) return keep("other provider")
  if (!enabled(input.env)) return keep(`routing off (${Brand.env.routing})`)
  const tiers = Brand.models as readonly string[]
  if (!tiers.includes(input.tier)) return keep("not a Rafiki tier")

  if (input.purpose === "turn" || (input.purpose === "subagent" && input.signal === "review")) {
    const signal = input.signal
    // /deep is the person's own choice, pinned or not; the others only on an unpinned session.
    if (!signal || (input.pinned && signal !== "deep")) return keep(input.pinned ? "pinned tier" : "session tier")
    if (strength(input.tier) >= strength(PRO)) return keep(`${reasons[signal]}; already on ${input.tier}`)
    return { tier: PRO, reason: reasons[signal], escalated: true }
  }

  if (input.pinned) return keep("pinned tier")
  if (input.purpose === "subagent" && input.agent !== "explore") return keep("session tier")
  const what = input.purpose === "subagent" ? "exploration subagent" : input.purpose === "title" ? "session title" : "compaction summary"
  if (input.tier === FAST) return keep(`${what}: session tier`)
  return { tier: FAST, reason: `${what}: rafiki-fast`, escalated: false }
}

// The signal of a turn from its user message and the turn so far (the plan
// agent's text, and the verify feedback of the checks).
export function signalOf(input: {
  sessionID: string
  agent: string
  text: string
  // Failing step commands of each verify feedback of this turn, oldest first.
  failures: string[][]
}): Signal | undefined {
  const asked = requestedFor(input.sessionID)
  if (asked) return asked
  const [before, last] = input.failures.slice(-2)
  if (before && last && last.some((command) => before.includes(command))) return "failing"
  if (input.agent === "plan" && wide(input.text)) return "plan"
  return undefined
}

// The choice of each assistant message, for the step events of
// `rafikicode run --format json`.
const decisions = new Map<string, Decision>()
const KEEP = 512
export function record(messageID: string, decision: Decision) {
  decisions.set(messageID, decision)
  while (decisions.size > KEEP) decisions.delete(decisions.keys().next().value!)
}
export const decisionFor = (messageID: string | undefined) => (messageID ? decisions.get(messageID) : undefined)

// For tests.
export function reset() {
  pins.clear()
  requested.clear()
  compacted.clear()
  decisions.clear()
}
