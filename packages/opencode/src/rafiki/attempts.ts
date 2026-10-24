// Parallel attempts: a hard task done two or three ways at once, each in a
// copy of the project, and only the best change kept
// (rafiki/attempts-run.ts runs them).
//
// when        `/attempts N <task>` in the terminal interface, `rafikicode run
//             --attempts N` or RAFIKICODE_ATTEMPTS=N (N is 2 or 3). With
//             `attempts.auto` (off by default) a run also gets them on the
//             difficulty signals of the routing helper (rafiki/routing.ts)
//             that are known before the task starts: --deep, or a wide change.
// where       each attempt works in its own git worktree of the project (with
//             the changes not committed yet), or in a copy when the project
//             is not a git repository. Dependency folders (node_modules,
//             vendor, .venv) are linked, not copied.
// how         on rafiki-fast by default (two Fast attempts cost less than one
//             Pro answer); `attempts.pro` or --deep puts the last one on
//             rafiki-pro. Each attempt gets a short hint with a different
//             approach, not only a different seed.
// which       the attempt whose own checks passed (the verify step,
//             rafiki/verify.ts), then the one whose acceptance criteria the
//             review found met (rafiki/review.ts), then the smaller diff. Only
//             that change is applied to the real working tree.
// limits      the attempts run at once only while the key's tokens per minute
//             limit leaves room for them (TPM_PER_ATTEMPT each); otherwise
//             they wait for a free place. Starts are staggered.
// cleanup     every worktree, copy and process is removed, however it ends.
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Routing from "./routing"

export interface Settings {
  auto?: boolean
  count?: number
  pro?: boolean
}

export const MIN = 2
export const MAX = 3
export const DEFAULT_COUNT = 3
// Tokens per minute one attempt may use at its peak: a request near the
// compaction point (150,000 tokens) and its follow up.
export const TPM_PER_ATTEMPT = 500_000
// Seconds between the starts of two attempts.
export const STAGGER_MS = 3_000
export const COMMAND = "attempts"
export const DESCRIPTION = "do the task 2 or 3 ways at once in copies of the project and keep the best change: /attempts N <task>"

type Env = Record<string, string | undefined>

// The count asked for with RAFIKICODE_ATTEMPTS: a number, "off" (no attempts,
// automatic ones included), or undefined when unset.
export function envSetting(env: Env = process.env): number | "off" | undefined {
  const value = env[Brand.env.attempts]?.trim().toLowerCase()
  if (!value) return undefined
  if (["0", "1", "off", "false", "no"].includes(value)) return "off"
  const count = Number(value)
  return Number.isInteger(count) ? clamp(count) : undefined
}

export const clamp = (count: number) => Math.min(MAX, Math.max(MIN, Math.round(count)))

// Why a count is refused, or undefined when it is 2 or 3.
export function invalid(count: unknown): string | undefined {
  if (typeof count === "number" && Number.isInteger(count) && count >= MIN && count <= MAX) return undefined
  return `the number of attempts is ${MIN} or ${MAX}`
}

// The attempts of a run: the count, and why. Undefined for a plain run.
export function decide(input: {
  flag?: number
  settings?: Settings
  deep?: boolean
  text: string
  env?: Env
}): { count: number; reason: string } | undefined {
  const env = envSetting(input.env)
  if (env === "off") return undefined
  if (input.flag !== undefined) return { count: input.flag, reason: "asked for with --attempts" }
  if (typeof env === "number") return { count: env, reason: `asked for with ${Brand.env.attempts}` }
  if (!input.settings?.auto) return undefined
  const count = clamp(input.settings.count ?? DEFAULT_COUNT)
  if (input.deep) return { count, reason: "attempts.auto: a hard task (--deep)" }
  if (Routing.wide(input.text)) return { count, reason: "attempts.auto: a hard task (a wide change)" }
  return undefined
}

// `/attempts N <task>`: the count and the task, or the reason it cannot run.
export function parseCommand(input: string): { count: number; task: string } | { error: string } {
  // `rafikicode run --command attempts "3 <task>"` passes the quoted words as they were typed.
  const trimmed = input.trim()
  const text = /^"[\s\S]*"$/.test(trimmed) ? trimmed.slice(1, -1).replace(/\\"/g, '"') : trimmed
  const match = /^\s*(\d+)\s+([\s\S]*\S)\s*$/.exec(text)
  if (!match) {
    const count = /^\s*(\d+)\s*$/.exec(text)
    if (count) return { error: "say what to do after the number: /attempts 3 <task>" }
    return { error: "usage: /attempts 2 <task> or /attempts 3 <task>" }
  }
  const count = Number(match[1])
  const why = invalid(count)
  if (why) return { error: why }
  return { count, task: match[2]! }
}

export interface Approach {
  name: string
  hint: string
}

export const APPROACHES: readonly Approach[] = [
  {
    name: "smallest change",
    hint: "Read the code involved and its callers first, find the cause, and fix it with as few changed lines as possible.",
  },
  {
    name: "test first",
    hint: "Start from a test: write or find one that shows the problem, run it and see it fail, then change the code until it passes, and run the tests next to it.",
  },
  {
    name: "follow the project",
    hint: "Look at how the project already handles similar cases (sibling functions, other branches of the same code, the tests) and make the change the same way, covering the related cases too.",
  },
]

// The tier of each attempt: rafiki-fast on the Rafiki tiers, the last one on
// rafiki-pro when asked for; any other model stays as it is.
export function tiers(input: { count: number; model?: string; pro?: boolean }): string[] {
  const model = input.model ?? `${Brand.provider.id}/${Routing.FAST}`
  const rafiki = model.startsWith(`${Brand.provider.id}/`)
  const base = rafiki && !input.pro ? model : rafiki ? `${Brand.provider.id}/${Routing.FAST}` : model
  return Array.from({ length: input.count }, (_, index) =>
    rafiki && input.pro && index === input.count - 1 ? `${Brand.provider.id}/${Routing.PRO}` : base,
  )
}

// The message of one attempt: the task, then its approach.
export function prompt(task: string, index: number, count: number) {
  const approach = APPROACHES[index % APPROACHES.length]!
  return [
    task,
    "",
    `[Attempt ${index + 1} of ${count}, in a separate copy of the project. Approach for this attempt: ${approach.hint} Work only in this folder, do not ask questions, and finish the task here; do not commit or push.]`,
  ].join("\n")
}

// How many attempts run at once under the key's tokens per minute limit.
export function concurrency(count: number, tpm: number | undefined) {
  if (tpm === undefined || !Number.isFinite(tpm) || tpm <= 0) return count
  return Math.max(1, Math.min(count, Math.floor(tpm / TPM_PER_ATTEMPT)))
}

export type ChecksStatus = "passed" | "failing" | "incomplete" | "unavailable" | "refused" | "none" | "not_run"

export interface Outcome {
  index: number
  tier: string
  approach: string
  // ok: the attempt ran to its end; error: it stopped with an error or a signal.
  ended: "ok" | "error"
  error?: string
  checks: ChecksStatus
  checksPassed: number
  checksRun: number
  criteria?: { met: number; total: number }
  diff: { files: number; added: number; removed: number }
  cost: number
  // gateway: every request of the attempt had the gateway's figure; partial: some had none.
  costSource: "gateway" | "partial"
  seconds: number
}

const checksRank: Record<ChecksStatus, number> = {
  passed: 2,
  none: 1,
  not_run: 1,
  incomplete: 1,
  unavailable: 1,
  refused: 1,
  failing: 0,
}

export const changed = (item: Outcome) => item.diff.files > 0
export const usable = (item: Outcome) => item.ended === "ok" && changed(item)
const size = (item: Outcome) => item.diff.added + item.diff.removed
const reviewRank = (item: Outcome) =>
  !item.criteria || item.criteria.total === 0 ? 1 : item.criteria.met === item.criteria.total ? 2 : 0
const reviewShare = (item: Outcome) => (item.criteria?.total ? item.criteria.met / item.criteria.total : 0)

// Negative when a is better than b.
export function compare(a: Outcome, b: Outcome) {
  return (
    Number(usable(b)) - Number(usable(a)) ||
    checksRank[b.checks] - checksRank[a.checks] ||
    reviewRank(b) - reviewRank(a) ||
    reviewShare(b) - reviewShare(a) ||
    size(a) - size(b) ||
    a.index - b.index
  )
}

// The attempt to keep and why, or undefined when none changed anything usable.
export function pick(outcomes: readonly Outcome[]): { winner: Outcome; reason: string } | undefined {
  const ranked = [...outcomes].sort(compare)
  const winner = ranked[0]
  if (!winner || !usable(winner)) return undefined
  const runner = ranked[1]
  if (!runner || !usable(runner)) return { winner, reason: "the only attempt with a change" }
  if (checksRank[winner.checks] > checksRank[runner.checks]) return { winner, reason: `${checksText(winner)}, attempt ${runner.index + 1} ${checksText(runner)}` }
  if (reviewRank(winner) > reviewRank(runner) || reviewShare(winner) > reviewShare(runner))
    return { winner, reason: `more criteria met (${criteriaText(winner)} against ${criteriaText(runner)})` }
  if (size(winner) < size(runner)) return { winner, reason: "the smaller diff of equal results" }
  return { winner, reason: "equal results and diff size, the first one" }
}

export function checksText(item: Outcome) {
  if (item.checks === "passed") return item.checksRun ? `checks passed (${item.checksPassed} of ${item.checksRun})` : "checks passed"
  if (item.checks === "failing") return `checks failing (${item.checksPassed} of ${item.checksRun} passed)`
  if (item.checks === "incomplete") return "checks not finished"
  if (item.checks === "unavailable") return "checks could not run"
  if (item.checks === "refused") return "checks not approved"
  if (item.checks === "none") return "no checks found"
  return "checks not run"
}

const criteriaText = (item: Outcome) => (item.criteria ? `criteria ${item.criteria.met} of ${item.criteria.total}` : "no review")

export function usd(value: number) {
  if (value > 0 && value < 0.001) return "<0.001 USD"
  return `${value.toFixed(3)} USD`
}

const tierName = (model: string) => model.split("/").slice(1).join("/") || model

// One line per attempt: checks, criteria, diff size, cost.
export function line(item: Outcome, kept: boolean) {
  const what = item.ended === "error" ? `stopped: ${item.error ?? "error"}` : !changed(item) ? "no change" : checksText(item)
  const diff = changed(item) ? `+${item.diff.added} -${item.diff.removed} in ${item.diff.files} ${item.diff.files === 1 ? "file" : "files"}` : undefined
  const parts = [what, item.criteria ? criteriaText(item) : undefined, diff, `${item.costSource === "partial" ? "about " : ""}${usd(item.cost)}`, `${Math.round(item.seconds)}s`]
  return `attempt ${item.index + 1} (${tierName(item.tier)}, ${item.approach}): ${parts.filter(Boolean).join(", ")}${kept ? "  [kept]" : ""}`
}

export interface Summary {
  outcomes: Outcome[]
  winner?: Outcome
  reason?: string
  applied: boolean
  // Why the winner's change could not be applied, and where its patch was saved.
  applyError?: string
  patchFile?: string
  total: number
  totalSource: "key_spend" | "attempts"
}

export function totalLine(summary: Summary) {
  const cost = `total ${usd(summary.total)}${summary.totalSource === "attempts" ? " (sum of the attempts)" : ""}`
  if (!summary.winner) return `attempts: no attempt made a usable change, nothing applied; ${cost}`
  if (!summary.applied)
    return `attempts: attempt ${summary.winner.index + 1} was best (${summary.reason}) but its change did not apply: ${summary.applyError}${summary.patchFile ? `; patch saved to ${summary.patchFile}` : ""}; ${cost}`
  return `attempts: kept attempt ${summary.winner.index + 1} (${summary.reason}), applied to the working tree; ${cost}`
}

// What the session's own turn gets after `/attempts` in the terminal
// interface: the task, what each attempt did and what was kept.
export function sessionNote(task: string, summary: Summary) {
  return [
    task,
    "",
    `[This task was done as ${summary.outcomes.length} parallel attempts, each in a copy of the project; only the best change was applied to the working tree. Results:`,
    ...summary.outcomes.map((item) => `- ${line(item, item === summary.winner && summary.applied)}`),
    `- ${totalLine(summary)}`,
    summary.applied
      ? "Do not redo the task. Look at the applied change (git diff), say in a few lines what it does and how it was checked, and fix only what is clearly broken.]"
      : "No change was applied. Say so in one or two lines and suggest the next step; do not start the task again unless it is asked for.]",
  ].join("\n")
}

// What one attempt's JSON events say (rafikicode run --format json).
export interface Events {
  checks: ChecksStatus
  checksPassed: number
  checksRun: number
  criteria?: { met: number; total: number }
  cost: number
  unknownCost: boolean
  steps: number
  error?: string
}

export function readEvents(lines: Iterable<string>): Events {
  const result: Events = { checks: "not_run", checksPassed: 0, checksRun: 0, cost: 0, unknownCost: false, steps: 0 }
  for (const raw of lines) {
    const text = raw.trim()
    if (!text.startsWith("{")) continue
    let event: Record<string, any>
    try {
      event = JSON.parse(text)
    } catch {
      continue
    }
    if (event.type === "step_finish") {
      result.steps++
      if (typeof event.cost === "number" && Number.isFinite(event.cost)) result.cost += event.cost
      else result.unknownCost = true
    }
    if (event.type === "verify" && typeof event.status === "string" && event.status !== "retry") {
      result.checks = (event.status in checksRank ? event.status : "not_run") as ChecksStatus
      const checks = Array.isArray(event.checks) ? event.checks : []
      result.checksRun = checks.filter((item: any) => item?.status === "passed" || item?.status === "failed").length
      result.checksPassed = checks.filter((item: any) => item?.status === "passed").length
    }
    // The final review event carries the cost of the criteria and of every review round.
    if (event.type === "review" && event.status !== "retry") {
      if (typeof event.cost === "number" && Number.isFinite(event.cost)) result.cost += event.cost
      if (Array.isArray(event.criteria) && event.status !== "unavailable")
        result.criteria = {
          total: event.criteria.length,
          met: event.criteria.filter((item: any) => item?.pass === true).length,
        }
    }
    if (event.type === "error") {
      const error = event.error
      result.error = String(error?.data?.message ?? error?.message ?? error?.name ?? "error").slice(0, 200)
    }
  }
  return result
}

export * as Attempts from "./attempts"
