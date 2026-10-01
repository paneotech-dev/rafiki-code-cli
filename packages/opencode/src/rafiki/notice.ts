// Workspace-trust warnings on their way to a surface that can show them.
//
// brand/trust.ts writes them with process.stderr.write, which is the right
// default for a command that owns the terminal and the wrong one for the
// full-screen interface: there the alternate screen is the TUI's, so a raw
// stderr line is either swallowed or scribbled across the frame. setWarn exists
// so a surface can redirect them; this is the redirect for the interface, and it
// turns each warning into the toast event the TUI already renders
// (app.tsx, "tui.toast.show").
//
// The warnings say that project plugins, custom tools, local MCP servers and
// permission rules the repository declares were dropped. Silently dropping them
// is the part that costs the person an afternoon.
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Guard from "@opencode-ai/core/brand/guard"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { TuiEvent } from "@opencode-ai/schema/tui-event"
import { Identifier } from "@/id/id"

export const TRUST_TITLE = `${Brand.product} workspace trust`

// Long enough to read a sentence that names a directory, and once only: warnOnce
// already keys them, so the same warning never queues twice.
export const TRUST_DURATION = 15_000

// One global event, narrowed to the toast the terminal interface renders, so a
// caller can read the message back without narrowing the whole event union.
export type NoticeEvent = GlobalEvent & {
  payload: Extract<GlobalEvent["payload"], { type: typeof TuiEvent.ToastShow.type }>
}

// The warning as the event the terminal interface shows. "global" because the
// warning is about the run, not about one session. The id is set here rather than
// left to the bus, so an event this process raises for itself carries one too.
export function toastEvent(message: string): NoticeEvent {
  return {
    directory: "global",
    payload: {
      id: Identifier.create("evt", "ascending"),
      type: TuiEvent.ToastShow.type,
      properties: { title: TRUST_TITLE, message: stripPrefix(message), variant: "warning", duration: TRUST_DURATION },
    },
  }
}

// trust.ts prefixes its messages with "Warning: " for a bare terminal line. The
// toast already says what it is in its title, so the prefix only takes up room.
export function stripPrefix(message: string) {
  return message.replace(/^Warning:\s*/, "")
}

// Routes every workspace-trust warning of this process to emit instead of
// stderr. Returns the previous sink, so a caller can put it back.
export function installTrustNotices(emit: (event: NoticeEvent) => void) {
  return Guard.setWarn((message) => emit(toastEvent(message)))
}
