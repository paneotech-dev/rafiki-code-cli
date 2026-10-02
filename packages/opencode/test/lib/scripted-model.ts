// A local OpenAI compatible chat completions server whose streamed answer is
// computed from the request, for tests that need a model which reacts to what
// it is sent (a tool result, a request to continue) instead of a fixed queue.
import http from "node:http"
import { listen } from "./fault-proxy"

export type Reply = {
  // Text deltas, one server sent event each.
  text?: string[]
  // One tool call; the arguments arrive in these fragments, one event each.
  tool?: { id: string; name: string; args: string[] }
  finish?: "stop" | "tool_calls" | "length"
}

export type Message = { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }

export type Script = (messages: Message[], body: Record<string, unknown>) => Reply

export type ScriptedModel = {
  readonly url: string
  script(next: Script): void
  close(): Promise<void>
}

function chunk(delta: Record<string, unknown>, finish?: string) {
  return {
    id: "chatcmpl-scripted",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
    ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}),
  }
}

// The events of one reply, in the order they are written. Event 1 is the role.
export function events(reply: Reply): string[] {
  const out: unknown[] = [chunk({ role: "assistant" })]
  for (const text of reply.text ?? []) out.push(chunk({ content: text }))
  if (reply.tool) {
    out.push(
      chunk({
        tool_calls: [
          { index: 0, id: reply.tool.id, type: "function", function: { name: reply.tool.name, arguments: "" } },
        ],
      }),
    )
    for (const args of reply.tool.args) out.push(chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }))
  }
  out.push(chunk({}, reply.finish ?? (reply.tool ? "tool_calls" : "stop")))
  return [...out.map((item) => `data: ${JSON.stringify(item)}\n\n`), "data: [DONE]\n\n"]
}

export function isTitleRequest(body: Record<string, unknown>) {
  return JSON.stringify(body).includes("Generate a title for this conversation")
}

export function textOf(message: Message | undefined): string {
  if (!message) return ""
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("")
}

export async function createScriptedModel(): Promise<ScriptedModel> {
  let script: Script = () => ({ text: ["ok"] })
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (piece: Buffer) => chunks.push(piece))
    req.on("end", () => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      } catch {}
      const messages = Array.isArray(body.messages) ? (body.messages as Message[]) : []
      const reply = isTitleRequest(body) ? { text: ["Scripted title"] } : script(messages, body)
      res.writeHead(200, { "content-type": "text/event-stream" })
      for (const event of events(reply)) res.write(event)
      res.end()
    })
  })
  const port = await listen(server)
  return {
    url: `http://127.0.0.1:${port}`,
    script(next) {
      script = next
    },
    close() {
      server.closeAllConnections?.()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
