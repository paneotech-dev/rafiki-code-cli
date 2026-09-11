#!/usr/bin/env node
// Minimal OpenAI compatible mock of the Rafiki gateway for local checks.
// Serves GET /v1/models and POST /v1/chat/completions (streaming and not)
// with a canned assistant reply, and logs every request to stderr so a run
// can prove the CLI reached it. No real provider is contacted.
//
//   node test/brand/mock-gateway.mjs [port]            (default 4180)
//   MOCK_GATEWAY_REPLY="..." overrides the canned reply
//   MOCK_GATEWAY_LOG=/path/file.jsonl appends one JSON line per request
import http from "node:http"
import fs from "node:fs"

const port = Number(process.argv[2] ?? process.env.MOCK_GATEWAY_PORT ?? 4180)
const reply = process.env.MOCK_GATEWAY_REPLY ?? "Mock gateway reply: request received."
const models = ["rafiki-fast", "rafiki-pro", "rafiki-max"]
const log = process.env.MOCK_GATEWAY_LOG

function record(entry) {
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry })
  process.stderr.write(line + "\n")
  if (log) fs.appendFileSync(log, line + "\n")
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function completion(model, text) {
  const id = "chatcmpl-mock-" + Date.now()
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  }
}

function stream(res, model, text) {
  const id = "chatcmpl-mock-" + Date.now()
  const created = Math.floor(Date.now() / 1000)
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  const chunk = (delta, finish) =>
    "data: " +
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }) +
    "\n\n"
  res.write(chunk({ role: "assistant", content: "" }, null))
  for (const word of text.split(" ")) res.write(chunk({ content: word + " " }, null))
  res.write(chunk({}, "stop"))
  res.write(
    "data: " +
      JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      }) +
      "\n\n",
  )
  res.write("data: [DONE]\n\n")
  res.end()
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`)
  const auth = req.headers.authorization ? "present" : "missing"
  if (req.method === "GET" && url.pathname === "/v1/models") {
    record({ method: req.method, path: url.pathname, authorization: auth })
    return json(res, 200, {
      object: "list",
      data: models.map((id) => ({ id, object: "model", created: 0, owned_by: "rafiki" })),
    })
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let raw = ""
    req.on("data", (part) => (raw += part))
    req.on("end", () => {
      let body = {}
      try {
        body = JSON.parse(raw)
      } catch {
        return json(res, 400, { error: { message: "invalid JSON body" } })
      }
      const model = typeof body.model === "string" ? body.model : "unknown"
      const messages = Array.isArray(body.messages) ? body.messages : []
      const last = messages.at(-1)
      record({
        method: req.method,
        path: url.pathname,
        authorization: auth,
        model,
        stream: body.stream === true,
        messages: messages.length,
        tools: Array.isArray(body.tools) ? body.tools.length : 0,
        last_user: typeof last?.content === "string" ? last.content.slice(0, 120) : undefined,
      })
      if (!models.includes(model)) return json(res, 404, { error: { message: `unknown model ${model}` } })
      if (body.stream === true) return stream(res, model, reply)
      return json(res, 200, completion(model, reply))
    })
    return
  }
  record({ method: req.method, path: url.pathname, status: 404 })
  json(res, 404, { error: { message: "not found" } })
})

server.listen(port, "127.0.0.1", () => {
  process.stderr.write(`mock gateway listening on http://127.0.0.1:${port}/v1\n`)
})
