// Send now, on the server (the rule is in core/brand/steer.ts). A user
// message marked "send now" asks the running turn of its session to stop at
// the next safe point, so the turn takes the message at its next step
// instead of after the step running now:
//
// - request(): the message was saved with the mark (a new prompt, or a part
//   update of a message already queued);
// - stop(): asked by the stream of the running step after each event. True
//   once a marked message is newer than the user message the step answers
//   and no tool call of the session is running or being written. The step
//   then ends where it is: its text, reasoning and finished tool calls are
//   kept, and the turn goes on with the queued messages as its next input;
// - settle(): the turn read its messages; a request it now answers is done.
//
// guard() counts the tool calls being executed per session, so a step is
// never cut while one runs, even one whose start the stream has not shown yet.
import * as Steer from "@opencode-ai/core/brand/steer"
import type { Tool } from "ai"

// Per session: the newest message marked "send now".
const wanted = new Map<string, string>()
// Per session: tool calls being executed.
const running = new Map<string, number>()

export function marked(parts: readonly unknown[] | undefined) {
  return (parts ?? []).some(Steer.marked)
}

export function request(sessionID: string, messageID: string) {
  const current = wanted.get(sessionID)
  if (!current || messageID > current) wanted.set(sessionID, messageID)
}

// The message the step answers is `user`; a marked message after it waits.
export function due(sessionID: string, user: string) {
  const id = wanted.get(sessionID)
  return id !== undefined && id > user
}

export function busy(sessionID: string) {
  return (running.get(sessionID) ?? 0) > 0
}

export function stop(sessionID: string, user: string, open: number) {
  return open === 0 && !busy(sessionID) && due(sessionID, user)
}

export function settle(sessionID: string, user: string) {
  const id = wanted.get(sessionID)
  if (id !== undefined && id <= user) wanted.delete(sessionID)
}

export function forget(sessionID?: string) {
  if (sessionID === undefined) {
    wanted.clear()
    running.clear()
    return
  }
  wanted.delete(sessionID)
  running.delete(sessionID)
}

function begin(sessionID: string) {
  running.set(sessionID, (running.get(sessionID) ?? 0) + 1)
}

function end(sessionID: string) {
  const next = (running.get(sessionID) ?? 1) - 1
  if (next <= 0) running.delete(sessionID)
  else running.set(sessionID, next)
}

export function guard<T extends Record<string, Tool>>(tools: T, sessionID: string): T {
  for (const item of Object.values(tools)) {
    const execute = item.execute
    if (!execute) continue
    item.execute = (...args: Parameters<typeof execute>) => {
      begin(sessionID)
      try {
        const result = execute(...args)
        if (result && typeof (result as PromiseLike<unknown>).then === "function")
          return Promise.resolve(result).finally(() => end(sessionID)) as ReturnType<typeof execute>
        end(sessionID)
        return result
      } catch (error) {
        end(sessionID)
        throw error
      }
    }
  }
  return tools
}
