// Workspace trust warnings, delivered to the ACP client instead of nowhere.
//
// brand/trust.ts raises a one line warning whenever an untrusted workspace
// costs the user something: project tools, custom commands, plugins, local MCP
// servers and permission grants are all dropped and named. It writes those to
// stderr. In the terminal that is the user's screen. Under ACP it is not: an
// editor captures the agent's stderr to a log file at best, so the user is
// told nothing at all while their project configuration is being ignored, and
// the turn still reports end_turn as if everything had loaded.
//
// trust.setWarn exists so a surface can redirect these. This installs a sink
// that keeps the stderr line (it is still the right place for a diagnostic, and
// it is the fallback whenever no sink is installed) and additionally queues the
// warning for delivery to the client.
//
// The channel is agent_message_chunk. ACP 0.21.0 has no logging or diagnostic
// method, and of the session update kinds it does have, only
// agent_message_chunk and session_info_update are seen by a person at all.
// session_info_update is session metadata, which clients render as a title or
// not at all, and dropping a warning into it would be as invisible as stderr.
// agent_message_chunk is the one kind every client must render where the user
// is looking, which is the whole point of the warning. A session/update
// notification is protocol, so this adds nothing to stdout that is not
// JSON-RPC: the raw text never goes near it.
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import * as BrandTrust from "@opencode-ai/core/brand/trust"
import { Effect } from "effect"

export type Connection = Pick<AgentSideConnection, "sessionUpdate">

const pending: string[] = []
let installed = false

// Redirects brand/trust warnings into the queue, keeping the stderr line. Safe
// to call more than once: only the first call installs.
export function install() {
  if (installed) return
  installed = true
  BrandTrust.setWarn((message) => {
    process.stderr.write(message + "\n")
    pending.push(message)
  })
}

// Removes and returns everything queued so far.
export function take(): readonly string[] {
  return pending.splice(0, pending.length)
}

// Delivers whatever is queued as agent message text. Called at the boundaries
// of a prompt turn, since a warning raised while opening a session has no turn
// of its own to belong to, and an agent message outside a turn has no place in
// a client's transcript.
export function flush(connection: Connection | undefined, sessionId: string) {
  if (!connection) return Effect.void
  const warnings = take()
  if (warnings.length === 0) return Effect.void
  return Effect.promise(async () => {
    for (const warning of warnings) {
      await connection
        .sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: warning },
          },
        })
        .catch(() => {})
    }
  })
}

export * as ACPWarning from "./warning"
