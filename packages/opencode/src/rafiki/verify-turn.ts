// The verify step at the end of a turn (rafiki/verify.ts holds the rules).
// Called by the session loop when the model has answered without asking for
// a tool. Returns "again" when a failure was sent back to the model as a new
// message, so the loop runs once more; "done" otherwise, after adding the
// line that says how the checks went to the answer.
import path from "path"
import { Effect } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Flag } from "@opencode-ai/core/flag/flag"
import type { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import * as Verify from "./verify"

export { Verify }

export interface Input {
  user: SessionV1.User
  assistant: SessionV1.Assistant
  messages: SessionV1.WithParts[]
  directory: string
  // The project root: the git worktree, or the directory outside git.
  root: string
  settings: Verify.Settings | undefined
  shell?: string
  // Asks the shell permission for the commands; false when it was refused.
  ask: (commands: string[]) => Effect.Effect<boolean>
  sessions: Pick<Session.Interface, "updateMessage" | "updatePart">
  env?: Record<string, string | undefined>
  // Told the outcome of the checks once the step is over (the review pass reads it).
  onFinal?: (result: Verify.Result) => void
  // The changed files as they were when the turn started (absolute paths),
  // and a key for that state; undefined when the session has no snapshot.
  // A file missing from the snapshot counts as new only when it is in `created`.
  before?: (files: string[], created: string[]) => Effect.Effect<{ key: string; files: Verify.Before } | undefined>
}

export const afterTurn = Effect.fnUntraced(function* (input: Input) {
  if (Flag.OPENCODE_DISABLE_PROJECT_CONFIG || !Verify.enabled(input.settings, input.env)) return "done" as const
  if (input.assistant.error || input.user.format?.type === "json_schema") return "done" as const
  const turn = Verify.turn(input.messages, input.directory)
  const files = Verify.relevant(input.root, turn.files)
  if (files.length === 0 || Verify.onlyDocs(files)) return "done" as const

  const steps = Verify.plan(input.root, files, input.settings)
  const budget = Verify.timeout(input.settings)
  const total = Verify.rounds(input.settings)
  const approved = steps.length > 0 && (yield* input.ask(steps.map((step) => step.command)))
  const before = approved && input.before ? yield* input.before(files.map((file) => path.join(input.root, file)), turn.created) : undefined
  const result: Verify.Result =
    steps.length === 0
      ? { status: "none", steps: [], budget }
      : approved
        ? yield* Effect.promise((signal) =>
            Verify.run({
              steps,
              cwd: input.root,
              budget,
              shell: input.shell,
              signal,
              before: before?.files,
              beforeKey: before?.key,
            }),
          )
        : {
            status: "refused",
            budget,
            steps: steps.map((step) => ({ ...step, status: "skipped", exit: null, seconds: 0, output: "" })),
          }

  // A round that ends with the very same failure as the one before gets no further round.
  if (result.status === "failing" && turn.rounds < total && !Verify.sameFailure(turn.last, result)) {
    const round = turn.rounds + 1
    const message = yield* input.sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: input.user.sessionID,
      time: { created: Date.now() },
      agent: input.user.agent,
      model: input.user.model,
    })
    const meta: Verify.FeedbackMeta = { kind: "feedback", round, rounds: total, result }
    yield* input.sessions.updatePart({
      id: PartID.ascending(),
      messageID: message.id,
      sessionID: input.user.sessionID,
      type: "text",
      synthetic: true,
      text: Verify.feedback(result, round, total),
      metadata: { [Verify.METADATA]: meta },
    })
    return "again" as const
  }

  input.onFinal?.(result)
  const now = Date.now()
  const meta: Verify.FinalMeta = { kind: "final", rounds: turn.rounds, result }
  yield* input.sessions.updatePart({
    id: PartID.ascending(),
    messageID: input.assistant.id,
    sessionID: input.assistant.sessionID,
    type: "text",
    text: Verify.finalLine(result, turn.rounds),
    time: { start: now, end: now },
    metadata: { [Verify.METADATA]: meta },
  })
  return "done" as const
})
