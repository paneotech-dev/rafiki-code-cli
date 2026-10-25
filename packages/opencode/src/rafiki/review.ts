// Acceptance criteria and the review pass (rafiki/review-turn.ts runs them).
//
// 1. At the start of a task that is not trivial, a short request to the small
//    model turns the user's request into 3 to 5 checkable acceptance criteria
//    and says whether the request reports a bug. The criteria go in the
//    session's todo list, where the user sees them, and in a note added to the
//    request, so the model works towards them. A bug report also gets the
//    reproduce first steps: a failing test (or a short script when the project
//    has no test setup) before the fix, kept once it passes.
// 2. Before the task is reported as done, a second request (rafiki-pro on the
//    Rafiki tiers) sees only the request, the criteria, the diff of the turn,
//    the results of the project's checks and the commands the turn ran, and
//    answers pass or fail for each criterion. A failure goes back to the model
//    for one more round (`review.rounds`, 0 or 1). The answer ends with a line
//    that says how the review went and what it cost.
//
// The criteria are on by default (`review.criteria: false` turns them off).
// The review pass is opt-in: `review.enabled: true` or RAFIKICODE_REVIEW=1. On
// the eval it caught none of the wrong edits and costs a request on every
// task, so it stays off until a stronger criteria writer or reviewer shows a
// gain. Trivial requests (a typo, a rename, a question) get no criteria and no
// review, and a turn that changed only documentation is not reviewed.
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import { isNote } from "./stuck"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import * as Routing from "./routing"

export interface Settings {
  enabled?: boolean
  criteria?: boolean
  model?: string
  rounds?: number
}

// The key of the part metadata that carries the criteria and the review results.
export const METADATA = "review"

export const DEFAULT_ROUNDS = 1
export const MAX_ROUNDS = 1
// The prefix of the todo items that hold the criteria.
export const CRITERION = "Criterion: "

const MIN_CRITERIA = 3
const MAX_CRITERIA = 5
const REQUEST_LIMIT = 8000
const DIFF_LIMIT = 24_000
const COMMAND_LIMIT = 12
const COMMAND_OUTPUT = 400
const CHECK_OUTPUT = 1500

export function envSetting(env: Record<string, string | undefined> = process.env): boolean | undefined {
  const value = env[Brand.env.review]?.trim().toLowerCase()
  if (!value) return undefined
  if (["1", "on", "true", "yes"].includes(value)) return true
  if (["0", "off", "false", "no"].includes(value)) return false
  return undefined
}

// The review pass: off unless turned on.
export function enabled(settings: Settings | undefined, env: Record<string, string | undefined> = process.env) {
  return envSetting(env) ?? settings?.enabled ?? false
}

// The acceptance criteria and the reproduce first steps: on unless turned off.
export function criteriaEnabled(settings: Settings | undefined) {
  return settings?.criteria ?? true
}

export function rounds(settings: Settings | undefined) {
  const value = settings?.rounds ?? DEFAULT_ROUNDS
  return Math.min(Math.max(Math.floor(value), 0), MAX_ROUNDS)
}

type Model = { providerID: string; modelID: string }

// The model of the review: review.model ("provider/model"), else the tier the
// routing gives the review step (rafiki/routing.ts: rafiki-pro, or the
// session's tier when it is stronger), else the model of the session.
export function reviewModel(
  settings: Settings | undefined,
  session: Model,
  input: { pinned?: boolean; env?: Record<string, string | undefined> } = {},
): Model & { reason: string } {
  const configured = settings?.model?.trim()
  if (configured && configured.includes("/")) {
    const [providerID, ...rest] = configured.split("/")
    return { providerID, modelID: rest.join("/"), reason: "review.model in the configuration" }
  }
  const route = Routing.choose({
    purpose: "review",
    providerID: session.providerID,
    tier: session.modelID,
    pinned: input.pinned ?? false,
    env: input.env,
  })
  return { providerID: session.providerID, modelID: route.tier, reason: route.reason }
}

// The model that writes the criteria: the cheap work tier of the routing
// (rafiki-fast on an unpinned Rafiki session), else the model of the session.
export function criteriaModel(
  session: Model,
  input: { pinned?: boolean; env?: Record<string, string | undefined> } = {},
): Model & { reason: string } {
  const route = Routing.choose({
    purpose: "criteria",
    providerID: session.providerID,
    tier: session.modelID,
    pinned: input.pinned ?? false,
    env: input.env,
  })
  return { providerID: session.providerID, modelID: route.tier, reason: route.reason }
}

// ---------------------------------------------------------------------------
// The request.

// What the user wrote in a message: its text parts, without the ones the session added.
export function requestText(message: SessionV1.WithParts | undefined) {
  if (!message || message.info.role !== "user") return ""
  return message.parts
    .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
    .join("\n")
    .trim()
}

const BUG =
  /\b(bugs?|fix(es|ed|ing)?|errors?|exceptions?|traceback|crash(es|ed|ing)?|broken|regression|incorrect(ly)?|wrong(ly)?|fails?|failing|failed|doesn'?t work|does not work|not working|unexpected(ly)?|raises?|hangs?|should (not )?(return|be|give|raise|work))\b/i
const TRIVIAL_EDIT =
  /\b(typos?|spelling|rename|reword|bump( the)? version|whitespace|indentation|reformat|format the|comment out|add a comment)\b/i
const QUESTION =
  /^(what|why|how|where|when|which|who|is|are|does|do|can|could|should|explain|describe|show me|tell me|list)\b/i

// True when the request reports a bug.
export function looksLikeBug(text: string) {
  return BUG.test(text)
}

// True for a request that needs no criteria: short, a question, or a small edit.
export function trivial(text: string) {
  const value = text.trim()
  if (value.length < 40) return true
  if (value.length < 300 && TRIVIAL_EDIT.test(value)) return true
  if (value.length < 400 && QUESTION.test(value) && value.endsWith("?") && !looksLikeBug(value)) return true
  return false
}

// ---------------------------------------------------------------------------
// Writing the criteria.

export const CRITERIA_SYSTEM = [
  "You turn a software task into acceptance criteria.",
  `Write ${MIN_CRITERIA} to ${MAX_CRITERIA} criteria that a reviewer can check from the code change and the test results alone.`,
  "Each criterion is one short sentence about observable behaviour or code: what must be true when the task is done.",
  "Use the exact names, values, messages and interfaces the request gives. Do not invent requirements the request does not state.",
  "Say whether the request reports a bug (wrong behaviour, an error, a failing case) or asks for something else.",
  'Reply with JSON only, no other text: {"bug": true, "criteria": ["...", "..."]}',
].join("\n")

export function criteriaPrompt(request: string) {
  return `The task:\n\n${clip(request, REQUEST_LIMIT)}`
}

export interface Criteria {
  bug: boolean
  criteria: string[]
}

// Criteria from the model's answer, undefined when it gave none that are usable.
export function parseCriteria(text: string, fallbackBug: boolean): Criteria | undefined {
  const value = json(text)
  if (!value || typeof value !== "object") return undefined
  const list = (value as { criteria?: unknown }).criteria
  if (!Array.isArray(list)) return undefined
  const criteria = list
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => item.length > 0)
    .map((item) => clip(item, 300))
    .slice(0, MAX_CRITERIA)
  if (criteria.length === 0) return undefined
  const bug = (value as { bug?: unknown }).bug
  return { bug: typeof bug === "boolean" ? bug : fallbackBug, criteria }
}

// The criterion every bug fix gets: the reproduction kept as a test.
export const REPRODUCED =
  "A test (or a short script when the project has no test setup) reproduces the reported bug: it fails without the fix and passes with it."

export function withReproduction(criteria: Criteria): string[] {
  if (!criteria.bug) return criteria.criteria
  return [...criteria.criteria.slice(0, MAX_CRITERIA - 1), REPRODUCED]
}

// The note added to the request: the criteria and, for a bug, how to reproduce it first.
export function note(input: { criteria: string[]; bug: boolean; testCommand?: string; reviewed?: boolean }) {
  const lines = [
    input.reviewed
      ? "Acceptance criteria for this task (they are in the todo list; a review checks each one before the task is done):"
      : "Acceptance criteria for this task (they are in the todo list; check each one before you say the task is done):",
    ...input.criteria.map((item, index) => `${index + 1}. ${item}`),
  ]
  if (input.bug) lines.push("", ...reproduce(input.testCommand))
  // Each todo update is a request that carries the whole list: on the eval of
  // 25 Oct 2026 small tasks spent up to a fifth of their cost ticking criteria
  // one at a time. The todo tool keeps the items the model leaves out.
  lines.push(
    "",
    "The todo list keeps these items when you rewrite it. Mark them completed in one update, once you have checked them all.",
  )
  return lines.join("\n")
}

// The reproduce first steps of a bug fix.
export function reproduce(testCommand?: string) {
  return [
    "This request reports a bug. Reproduce it before you fix it:",
    "1. Write a test next to the existing tests of that code that shows the wrong behaviour. When the project has no test setup, write a short script instead.",
    `2. Run it and confirm it fails the way the request describes${testCommand ? ` (the project's tests run with \`${testCommand}\`)` : ""}.`,
    "3. Fix the code, then run the test again until it passes, and run the existing tests of the code you changed.",
    "4. Keep the test. If the bug cannot be reproduced here (a missing service or tool), say so and fix it from the code.",
  ]
}

export function todoOf(criterion: string) {
  return { content: CRITERION + criterion, status: "pending", priority: "high" }
}

export function isCriterion(todo: { content: string }) {
  return todo.content.startsWith(CRITERION)
}

// A todo list written by the model keeps the criteria it left out, first.
export function keepCriteria<T extends { content: string }>(previous: readonly T[], next: readonly T[]): T[] {
  const missing = previous.filter((todo) => isCriterion(todo) && !next.some((item) => item.content === todo.content))
  return [...missing, ...next]
}

// The criteria items ticked from a verdict: met ones completed, the others pending.
export function tick<T extends { content: string; status: string }>(
  todos: readonly T[],
  criteria: string[],
  verdict: Verdict,
): T[] {
  return todos.map((todo) => {
    if (!isCriterion(todo)) return todo
    const index = criteria.indexOf(todo.content.slice(CRITERION.length))
    const result = verdict.results.find((item) => item.index === index)
    if (index === -1 || !result) return todo
    return { ...todo, status: result.pass ? "completed" : "pending" }
  })
}

// ---------------------------------------------------------------------------
// The review.

export const REVIEW_SYSTEM = [
  "You review a finished code change against its acceptance criteria.",
  "You see the request, the criteria, the diff of the change, the results of the project's checks and the commands that were run.",
  "For each criterion, answer pass or fail with a one line reason. Pass only when the diff and the results show the criterion is met.",
  "Fail a criterion when the change does it differently from what the request asks (another name, value, message or interface), when it breaks other behaviour, or when nothing shows it works.",
  "Do not ask for changes the criteria do not need.",
  'Reply with JSON only, no other text: {"results": [{"id": 1, "pass": true, "reason": "..."}]}',
].join("\n")

export interface Command {
  command: string
  exit: number | null
  output: string
}

export interface CheckLine {
  command: string
  status: string
  output?: string
}

export function reviewPrompt(input: {
  request: string
  criteria: string[]
  diff: string
  checks: CheckLine[]
  commands: Command[]
  tests: string[]
}) {
  const checks = input.checks.length
    ? input.checks
        .map((check) => {
          const output = check.output?.trim() ? `\n${clip(check.output.trim(), CHECK_OUTPUT, true)}` : ""
          return `$ ${check.command}: ${check.status}${output}`
        })
        .join("\n")
    : "(no project checks ran)"
  const commands = input.commands.length
    ? input.commands
        .map(
          (item) =>
            `$ ${item.command}\nexit code ${item.exit ?? "unknown"}\n${clip(item.output.trim(), COMMAND_OUTPUT, true)}`,
        )
        .join("\n\n")
    : "(none)"
  return [
    "## Request",
    clip(input.request, REQUEST_LIMIT),
    "",
    "## Criteria",
    ...input.criteria.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## Diff",
    input.diff.trim() ? clip(input.diff, DIFF_LIMIT) : "(empty)",
    "",
    `Test files changed: ${input.tests.length ? input.tests.join(", ") : "none"}`,
    "",
    "## Project checks after the change",
    checks,
    "",
    "## Commands run during the task (last ones, output shortened)",
    commands,
  ].join("\n")
}

export interface Result {
  index: number
  pass: boolean
  reason: string
}

export interface Verdict {
  results: Result[]
}

// The verdict from the reviewer's answer: one result per criterion, by its
// number. Undefined when the answer cannot be read.
export function parseVerdict(text: string, count: number): Verdict | undefined {
  const value = json(text)
  if (!value || typeof value !== "object") return undefined
  const list = (value as { results?: unknown }).results
  if (!Array.isArray(list)) return undefined
  const results: Result[] = []
  list.forEach((item, position) => {
    if (!item || typeof item !== "object") return
    const entry = item as { id?: unknown; pass?: unknown; reason?: unknown }
    const id = typeof entry.id === "number" ? entry.id : typeof entry.id === "string" ? Number(entry.id) : position + 1
    const index = Number.isInteger(id) ? id - 1 : position
    if (index < 0 || index >= count || results.some((result) => result.index === index)) return
    const pass = entry.pass === true || entry.pass === "pass" || entry.pass === "true"
    results.push({ index, pass, reason: typeof entry.reason === "string" ? clip(entry.reason.trim(), 400) : "" })
  })
  if (results.length === 0) return undefined
  return { results: results.toSorted((a, b) => a.index - b.index) }
}

export function failed(verdict: Verdict) {
  return verdict.results.filter((result) => !result.pass)
}

// The message that sends the failed criteria back to the model.
export function feedback(criteria: string[], verdict: Verdict, round: number, total: number) {
  return [
    `A review of your change found criteria that are not met yet (review round ${round} of ${total}):`,
    "",
    ...failed(verdict).map(
      (result) => `${result.index + 1}. ${criteria[result.index]}\n   ${result.reason || "not shown by the change"}`,
    ),
    "",
    "Fix what is missing, run the relevant tests again, then answer. If a criterion is wrong for this request, say why in your answer instead.",
  ].join("\n")
}

export function usd(value: number) {
  if (value <= 0) return "0 USD"
  if (value < 0.001) return "under 0.001 USD"
  return `${value.toFixed(value < 0.1 ? 3 : 2)} USD`
}

// The line added to the answer once the review is over.
export function finalLine(input: {
  criteria: string[]
  verdict?: Verdict
  model: string
  cost: number
  rounds: number
}) {
  const cost = `review on ${input.model}, ${usd(input.cost)}`
  if (!input.verdict) return `review not available (the reviewer gave no usable answer); ${cost}`
  const missed = failed(input.verdict)
  const met = input.verdict.results.length - missed.length
  const tried = input.rounds > 0 ? ` after ${input.rounds} review round${input.rounds === 1 ? "" : "s"}` : ""
  if (missed.length === 0) return `criteria met: ${met} of ${input.criteria.length}${tried} (${cost})`
  const list = missed.map((result) => `${result.index + 1}. ${input.criteria[result.index]}`).join("; ")
  return `criteria not met: ${list}${tried} (${cost})`
}

// ---------------------------------------------------------------------------
// What the session keeps.

export interface CriteriaMeta {
  kind: "criteria"
  criteria: string[]
  bug: boolean
  cost: number
}

export interface FeedbackMeta {
  kind: "feedback"
  round: number
  rounds: number
  verdict: Verdict
  cost: number
}

export interface FinalMeta {
  kind: "final"
  rounds: number
  criteria: string[]
  verdict?: Verdict
  model: string
  cost: number
}

export type Meta = CriteriaMeta | FeedbackMeta | FinalMeta

export function metaOf(part: { type: string; metadata?: Record<string, unknown> }): Meta | undefined {
  if (part.type !== "text") return undefined
  const value = part.metadata?.[METADATA]
  if (!value || typeof value !== "object") return undefined
  const kind = (value as { kind?: unknown }).kind
  return kind === "criteria" || kind === "feedback" || kind === "final" ? (value as Meta) : undefined
}

// The turn so far, from the last message the user wrote (not a verify or
// review round): its criteria, the review rounds it has had, and what the
// criteria and reviews cost so far.
export function turn(messages: SessionV1.WithParts[]) {
  const round = (msg: SessionV1.WithParts) =>
    msg.parts.some((part) => {
      const meta = metaOf(part)
      if (meta?.kind === "feedback") return true
      const verify = part.type === "text" ? (part.metadata?.["verify"] as { kind?: unknown } | undefined) : undefined
      return verify?.kind === "feedback"
    })
  // A stuck note (rafiki/stuck.ts) continues the turn too.
  const start = messages.findLastIndex((msg) => msg.info.role === "user" && !round(msg) && !isNote(msg))
  const since = start === -1 ? [] : messages.slice(start)
  const metas = since.flatMap((msg) => msg.parts.map(metaOf)).filter((meta): meta is Meta => Boolean(meta))
  const criteria = metas.find((meta): meta is CriteriaMeta => meta.kind === "criteria")
  const feedbacks = metas.filter((meta): meta is FeedbackMeta => meta.kind === "feedback")
  const cost = (criteria?.cost ?? 0) + feedbacks.reduce((sum, meta) => sum + meta.cost, 0)
  return { start: since[0], since, criteria, rounds: feedbacks.length, cost }
}

// The shell commands the turn ran, last ones first kept, in order.
export function commandsOf(messages: SessionV1.WithParts[]): Command[] {
  const out: Command[] = []
  for (const msg of messages) {
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type !== "tool" || part.tool !== "bash" || part.state.status !== "completed") continue
      const input = part.state.input as { command?: unknown }
      const meta = part.state.metadata as { exit?: unknown } | undefined
      if (typeof input.command !== "string") continue
      out.push({
        command: clip(input.command.trim(), 300),
        exit: typeof meta?.exit === "number" ? meta.exit : null,
        output: part.state.output ?? "",
      })
    }
  }
  return out.slice(-COMMAND_LIMIT)
}

const TEST_FILE =
  /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|\.(test|spec)\.[cm]?[jt]sx?$|Test\.php$/

export function isTestFile(file: string) {
  return TEST_FILE.test(file.replaceAll("\\", "/"))
}

// The diff of the changed files when no snapshot of the turn's start is
// available: what git shows against HEAD, and new files in full.
export function gitDiffArgs(files: string[]) {
  return ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", ...files]
}

export function relative(root: string, file: string) {
  return path.relative(root, file).replaceAll("\\", "/")
}

// ---------------------------------------------------------------------------

function clip(text: string, limit: number, tail = false) {
  if (text.length <= limit) return text
  return tail ? "...\n" + text.slice(text.length - limit) : text.slice(0, limit) + "\n..."
}

// The first JSON object in a model's answer, after any reasoning block or code fence.
export function json(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]
  const candidates = [fenced, cleaned].filter((item): item is string => Boolean(item))
  for (const candidate of candidates) {
    const start = candidate.indexOf("{")
    const end = candidate.lastIndexOf("}")
    if (start === -1 || end <= start) continue
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      continue
    }
  }
  return undefined
}

export * as Review from "./review"
