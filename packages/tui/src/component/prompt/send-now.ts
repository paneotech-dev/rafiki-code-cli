// Send now (core/brand/steer.ts): marks the newest message waiting for the
// running turn, so the turn takes it at its next safe point. The messages
// queued before it go with it: the next step reads every message saved.
import * as Steer from "@opencode-ai/core/brand/steer"
import type { Message, Part, TextPart } from "@opencode-ai/sdk/v2"

interface Client {
  part: {
    update(input: { sessionID: string; messageID: string; partID: string; part?: Part }): Promise<unknown>
  }
}

interface Store {
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
}

export function queued(store: Store, sessionID: string) {
  return Steer.queued(store.message[sessionID] ?? [])
}

// The text part the mark goes on: the typed text, not added context.
export function target(store: Store, sessionID: string, messageID?: string) {
  const list = queued(store, sessionID)
  const message = messageID ? list.find((item) => item.id === messageID) : list.at(-1)
  if (!message) return undefined
  const parts = (store.part[message.id] ?? []).filter((part): part is TextPart => part.type === "text")
  const part = parts.find((item) => !item.synthetic) ?? parts[0]
  if (!part) return undefined
  return { message, part }
}

// True when a queued message was marked.
export async function sendQueued(client: Client, store: Store, sessionID: string, messageID?: string) {
  const found = target(store, sessionID, messageID)
  if (!found) return false
  if (Steer.marked(found.part)) return true
  await client.part.update({
    sessionID,
    messageID: found.message.id,
    partID: found.part.id,
    part: { ...found.part, metadata: Steer.metadata(found.part.metadata) },
  })
  return true
}

export const TOAST = "Sending now: the running turn stops after its current tool call and takes your message next."
