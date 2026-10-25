// Acceptance criteria at the start of a task and the review pass before it is
// done (rafiki/review.ts holds the rules). Called by the session loop: start()
// before the first request of a turn, afterTurn() once the verify step is over.
import { Effect } from "effect"
import { spawnSync } from "child_process"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Flag } from "@opencode-ai/core/flag/flag"
import type { Session } from "@/session/session"
import type { Todo } from "@/session/todo"
import { MessageID, PartID } from "@/session/schema"
import * as Review from "./review"
import * as Verify from "./verify"

export { Review }

export interface Model {
  providerID: string
  modelID: string
  // Why this model, from the routing (rafiki/routing.ts).
  reason?: string
}

// One request outside the conversation: its answer and its cost, or undefined when it failed.
export type Ask = (input: {
  model: Model
  system: string
  prompt: string
  small: boolean
}) => Effect.Effect<{ text: string; cost: number } | undefined>

type Sessions = Pick<Session.Interface, "updateMessage" | "updatePart">
type Todos = Pick<Todo.Interface, "get" | "update">

function off(settings: Review.Settings | undefined, env?: Record<string, string | undefined>) {
  return Flag.OPENCODE_DISABLE_PROJECT_CONFIG || !Review.enabled(settings, env)
}

function noCriteria(settings: Review.Settings | undefined) {
  return Flag.OPENCODE_DISABLE_PROJECT_CONFIG || !Review.criteriaEnabled(settings)
}

export interface StartInput {
  user: SessionV1.User
  message: SessionV1.WithParts
  messages: SessionV1.WithParts[]
  root: string
  settings: Review.Settings | undefined
  verify: Verify.Settings | undefined
  ask: Ask
  sessions: Sessions
  todos: Todos
  // Whether the session's tier is pinned (rafiki/routing.ts).
  pinned?: boolean
  env?: Record<string, string | undefined>
}

// The criteria of a new task: written once per message the user wrote, kept
// in the todo list and in a note added to the message. Returns the note's part.
export const start = Effect.fnUntraced(function* (input: StartInput) {
  if (noCriteria(input.settings)) return undefined
  if (input.user.format?.type === "json_schema" || input.user.agent === "plan") return undefined
  if (input.message.parts.some((part) => Review.metaOf(part))) return undefined
  // A message already answered (a resumed turn) keeps what it had.
  if (input.messages.some((msg) => msg.info.role === "assistant" && msg.info.parentID === input.user.id))
    return undefined
  const request = Review.requestText(input.message)
  if (!request || Review.trivial(request)) return undefined

  const answer = yield* input.ask({
    model: Review.criteriaModel(input.user.model, { pinned: input.pinned, env: input.env }),
    system: Review.CRITERIA_SYSTEM,
    prompt: Review.criteriaPrompt(request),
    small: true,
  })
  const parsed = answer ? Review.parseCriteria(answer.text, Review.looksLikeBug(request)) : undefined
  if (!parsed) return undefined
  const criteria = Review.withReproduction(parsed)
  const testCommand = parsed.bug ? testCommandOf(input.root, input.verify) : undefined

  const todos = yield* input.todos.get(input.user.sessionID)
  yield* input.todos.update({
    sessionID: input.user.sessionID,
    todos: [...criteria.map(Review.todoOf), ...todos.filter((todo) => !Review.isCriterion(todo))],
  })
  const meta: Review.CriteriaMeta = { kind: "criteria", criteria, bug: parsed.bug, cost: answer?.cost ?? 0 }
  const part: SessionV1.TextPart = {
    id: PartID.ascending(),
    messageID: input.user.id,
    sessionID: input.user.sessionID,
    type: "text",
    synthetic: true,
    text: Review.note({ criteria, bug: parsed.bug, testCommand, reviewed: Review.enabled(input.settings, input.env) }),
    metadata: { [Review.METADATA]: meta },
  }
  yield* input.sessions.updatePart(part)
  return part
})

function testCommandOf(root: string, settings: Verify.Settings | undefined) {
  try {
    return Verify.detect(root, settings).checks.find((check) => check.kind === "test")?.command
  } catch {
    return undefined
  }
}

export interface AfterInput {
  user: SessionV1.User
  assistant: SessionV1.Assistant
  messages: SessionV1.WithParts[]
  directory: string
  root: string
  settings: Review.Settings | undefined
  // The outcome of the verify step of this turn, when it ran.
  checks: Verify.Result | undefined
  // The diff of the turn: from the snapshot taken at its start, or undefined when there is none.
  diff: (from: string | undefined) => Effect.Effect<string | undefined>
  ask: Ask
  sessions: Sessions
  todos: Todos
  // Whether the session's tier is pinned (rafiki/routing.ts).
  pinned?: boolean
  env?: Record<string, string | undefined>
}

// The review of a finished turn. "again" when criteria not met were sent back
// to the model for one more round; "done" otherwise, after adding the line
// that says how the review went to the answer.
export const afterTurn = Effect.fnUntraced(function* (input: AfterInput) {
  if (off(input.settings, input.env)) return "done" as const
  if (input.assistant.error || input.user.format?.type === "json_schema") return "done" as const
  const turn = Review.turn(input.messages)
  if (!turn.criteria || !turn.start) return "done" as const
  // Only a turn that changed files, and not only documentation, is reviewed.
  const files = Verify.relevant(input.root, Verify.turn(input.messages, input.directory).files)
  if (files.length === 0 || Verify.onlyDocs(files)) return "done" as const

  const criteria = turn.criteria.criteria
  const from = snapshotOf(turn.since)
  const diff = (yield* input.diff(from)) ?? gitDiff(input.root, files)
  const checks: Review.CheckLine[] = (input.checks?.steps ?? []).map((step) => ({
    command: step.command,
    status: step.status,
    output: step.status === "failed" ? step.output : undefined,
  }))
  const model = Review.reviewModel(input.settings, input.user.model, { pinned: input.pinned, env: input.env })
  const request = {
    model,
    system: Review.REVIEW_SYSTEM,
    prompt: Review.reviewPrompt({
      request: Review.requestText(turn.start),
      criteria,
      diff,
      checks,
      commands: Review.commandsOf(turn.since),
      tests: files.filter(Review.isTestFile),
    }),
    small: false,
  }
  // An answer that cannot be read is asked for once more.
  let cost = 0
  let verdict: Review.Verdict | undefined
  for (const attempt of [1, 2]) {
    const answer = yield* input.ask(request)
    cost += answer?.cost ?? 0
    verdict = answer ? Review.parseVerdict(answer.text, criteria.length) : undefined
    if (verdict) break
    yield* Effect.logWarning("review answer not usable", { attempt, answer: answer?.text.slice(0, 300) ?? "(failed)" })
  }
  const total = Review.rounds(input.settings)

  if (verdict) {
    const todos = yield* input.todos.get(input.user.sessionID)
    if (todos.some(Review.isCriterion))
      yield* input.todos.update({ sessionID: input.user.sessionID, todos: Review.tick(todos, criteria, verdict) })
  }

  // The cost of the criteria and of every review of the turn counts in the answer's cost.
  const spent = turn.cost + cost
  const added = cost + (turn.rounds === 0 ? turn.criteria.cost : 0)
  if (added > 0) {
    input.assistant.cost += added
    yield* input.sessions.updateMessage(input.assistant)
  }

  if (verdict && Review.failed(verdict).length > 0 && turn.rounds < total) {
    const round = turn.rounds + 1
    const message = yield* input.sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: input.user.sessionID,
      time: { created: Date.now() },
      agent: input.user.agent,
      model: input.user.model,
    })
    const meta: Review.FeedbackMeta = { kind: "feedback", round, rounds: total, verdict, cost }
    yield* input.sessions.updatePart({
      id: PartID.ascending(),
      messageID: message.id,
      sessionID: input.user.sessionID,
      type: "text",
      synthetic: true,
      text: Review.feedback(criteria, verdict, round, total),
      metadata: { [Review.METADATA]: meta },
    })
    return "again" as const
  }

  const now = Date.now()
  const meta: Review.FinalMeta = {
    kind: "final",
    rounds: turn.rounds,
    criteria,
    verdict,
    model: model.modelID,
    cost: spent,
  }
  yield* input.sessions.updatePart({
    id: PartID.ascending(),
    messageID: input.assistant.id,
    sessionID: input.assistant.sessionID,
    type: "text",
    text: Review.finalLine({ criteria, verdict, model: model.modelID, cost: spent, rounds: turn.rounds }),
    time: { start: now, end: now },
    metadata: { [Review.METADATA]: meta },
  })
  return "done" as const
})

// The snapshot taken at the first step of the turn.
function snapshotOf(messages: SessionV1.WithParts[]) {
  for (const msg of messages) {
    if (msg.info.role !== "assistant") continue
    const part = msg.parts.find((item) => item.type === "step-start" && item.snapshot)
    if (part && part.type === "step-start") return part.snapshot
  }
  return undefined
}

function gitDiff(root: string, files: string[]) {
  const tracked = spawnSync("git", Review.gitDiffArgs(files), {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15_000,
  })
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "--", ...files], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
  })
  const added = (untracked.status === 0 ? untracked.stdout.split("\n").filter(Boolean) : []).map((file) => {
    const result = spawnSync("git", ["diff", "--no-color", "--no-index", "--", "/dev/null", file], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15_000,
    })
    return result.stdout ?? ""
  })
  return [tracked.status === 0 ? tracked.stdout : "", ...added].filter(Boolean).join("\n")
}
