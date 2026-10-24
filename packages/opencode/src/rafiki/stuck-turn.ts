// Stuck detection in the session loop (rafiki/stuck.ts holds the rules).
// Called after a step that ran tools, before the next request. Returns the
// note's metadata when one was added as a new message (the loop then runs
// again on it), undefined otherwise. The tier is not changed here: the note is
// a routing signal (rafiki/routing.ts), and `route` is what the routing
// decides for it, so the note and the user's line can say so.
import { Effect } from "effect"
import { Brand } from "@opencode-ai/core/brand/brand"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import * as Stuck from "./stuck"

export { Stuck }

export function enabled(env: Record<string, string | undefined> = process.env) {
  const value = env[Brand.env.stuck]?.trim().toLowerCase()
  return !(value && ["0", "off", "false", "no"].includes(value))
}

export interface Input {
  user: SessionV1.User
  messages: SessionV1.WithParts[]
  sessions: Pick<Session.Interface, "updateMessage" | "updatePart">
  // The routing decision for a stuck turn; undefined for a subagent.
  route?: { tier: string; escalated: boolean }
  env?: Record<string, string | undefined>
}

export const afterStep = Effect.fnUntraced(function* (input: Input) {
  if (!enabled(input.env)) return undefined
  const finding = Stuck.scan(input.messages)
  if (!finding) return undefined
  // Only the first note of a turn moves it; a later one finds it moved already.
  const moves = input.route?.escalated && !Stuck.noted(input.messages) ? input.route.tier : undefined
  const meta: Stuck.Meta = {
    ...finding,
    kind: "stuck",
    ...(moves ? { escalated: { from: input.user.model.modelID, to: moves } } : {}),
  }
  const message = yield* input.sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: input.user.sessionID,
    time: { created: Date.now() },
    agent: input.user.agent,
    // The session's tier stays; the routing picks the tier of each request.
    model: input.user.model,
    ...(input.user.system ? { system: input.user.system } : {}),
    ...(input.user.tools ? { tools: input.user.tools } : {}),
  })
  yield* input.sessions.updatePart({
    id: PartID.ascending(),
    messageID: message.id,
    sessionID: input.user.sessionID,
    type: "text",
    synthetic: true,
    text: Stuck.note(finding, moves),
    metadata: { [Stuck.METADATA]: meta },
  })
  return meta
})
