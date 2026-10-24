// User interface work in a session (brand/design.ts has the detection, the
// guide and the plan note). Applied to the messages of every request, in
// memory only, like the plan mode reminders (session/reminders.ts):
//
// - the design guide is added to the first request of the session that is
//   user interface work, so every later step and turn sees it at the same
//   place in the history and the cached prefix stays the same;
// - on that request, the agent is asked for a short layout plan (sections,
//   components, states) and to stop until the person answers. Skipped when the
//   request says so ("no plan", "just build it"), with "design": { "plan":
//   false }, in Plan mode (which plans anyway), in a subagent, and where nobody
//   can answer: rafikicode run, serve, github and pr.
import { Design } from "@opencode-ai/core/brand/design"
import { Brand } from "@opencode-ai/core/brand/brand"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { PartID } from "@/session/schema"

// Commands where no person reads the plan before the turn ends.
const UNATTENDED = new Set(["run", "serve", "github", "pr"])

export function attended(command: string | undefined = Brand.command()) {
  return command === undefined || !UNATTENDED.has(command)
}

// What the person typed in a user message, without the parts added for the model.
export function requestText(message: SessionV1.WithParts) {
  return message.parts
    .filter((part) => part.type === "text" && !part.synthetic)
    .map((part) => (part as { text: string }).text)
    .join("\n")
}

function requestFiles(message: SessionV1.WithParts) {
  return message.parts.flatMap((part) => {
    if (part.type !== "file") return []
    const file = part as { filename?: string; url?: string }
    return [file.filename ?? file.url ?? ""].filter(Boolean)
  })
}

export interface Applied {
  guide: boolean
  plan: boolean
}

export function apply(input: {
  messages: SessionV1.WithParts[]
  settings?: Design.Settings
  agent: string
  subagent: boolean
  attended?: boolean
}): Applied {
  const none = { guide: false, plan: false }
  const guide = Design.guideEnabled(input.settings)
  const planOn = Design.planEnabled(input.settings)
  if (!guide && !planOn) return none
  const first = input.messages.find(
    (message) =>
      message.info.role === "user" && Design.detect({ text: requestText(message), files: requestFiles(message) }),
  )
  if (!first) return none
  const plan =
    planOn &&
    !input.subagent &&
    input.agent !== "plan" &&
    (input.attended ?? attended()) &&
    !Design.skipPlan(requestText(first))
  const add = (text: string) =>
    first.parts.push({
      id: PartID.ascending(),
      messageID: first.info.id,
      sessionID: first.info.sessionID,
      type: "text",
      text,
      synthetic: true,
    } as SessionV1.WithParts["parts"][number])
  if (guide) add(`${Design.GUIDE_INTRO}\n\n${Design.guide()}`)
  if (plan) add(Design.PLAN_NOTE)
  return { guide, plan }
}
