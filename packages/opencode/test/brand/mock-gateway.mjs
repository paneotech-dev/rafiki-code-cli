#!/usr/bin/env node
// Mock of the Rafiki gateway (LiteLLM) for local checks and tests. Two halves:
//
// The OpenAI compatible half serves GET /v1/models and POST /v1/chat/completions
// (streaming and not) with a canned reply and logs every request to stderr, so
// a run can prove the CLI reached it, plus GET /health/liveliness for doctor.
// No real provider is contacted.
//
// The admin half mimics the LiteLLM endpoints the Console uses to mint and
// manage virtual keys: POST /key/generate, GET /key/info, GET /key/list,
// POST /key/update, POST /key/delete. Keys minted there are enforced on the
// chat half the way the real gateway does it: an unknown or deleted key is a
// 401, a model outside the key's list is a 403 key_model_access_denied, and a
// key past its max_budget is a 429 budget_exceeded. Each successful call adds
// a fixed cost to the key's spend and answers with x-litellm-response-cost.
//
//   node test/brand/mock-gateway.mjs [port]            (default 4180)
//   MOCK_GATEWAY_REPLY="..."     overrides the canned reply
//   MOCK_GATEWAY_LOG=/path.jsonl appends one JSON line per request
//   MOCK_GATEWAY_ENFORCE=1       require a minted key even before any was minted
//   MOCK_GATEWAY_COST=0.001      spend added per successful chat call, in USD
//   MOCK_GATEWAY_FAIL=budget|revoked|denied|down|rate   fail every chat call that way
//   MOCK_GATEWAY_EMPTY_LENGTH=1  answer like a reasoning model out of budget: reasoning only, no content, finish length
//
// GET /v1/model/info answers with the price list the way LiteLLM does (per
// token prices under litellm_params), for the models the key may use; the
// prices option replaces the list, and prices: false makes the route a 404.
// The usage option replaces the usage block of every chat answer, so a test
// can report cached tokens. The answeredBy option answers a tier on another
// one, like the gateway after a fallback.
import http from "node:http"
import fs from "node:fs"
import crypto from "node:crypto"

const MODELS = ["rafiki-fast", "rafiki-pro", "rafiki-max"]

// Round test figures, not anyone's real prices: USD per token.
export const MOCK_PRICES = {
  "rafiki-fast": { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002, cache_read_input_token_cost: 0.0000001 },
  "rafiki-pro": { input_cost_per_token: 0.000004, output_cost_per_token: 0.000008, cache_read_input_token_cost: 0.000001 },
  "rafiki-max": {
    input_cost_per_token: 0.00001,
    output_cost_per_token: 0.00002,
    cache_read_input_token_cost: 0.000001,
    cache_creation_input_token_cost: 0.0000125,
  },
}
const USAGE = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }

export function createMockGateway(options = {}) {
  const opts = {
    port: options.port ?? 0,
    reply: options.reply ?? "Mock gateway reply: request received.",
    log: options.log,
    quiet: options.quiet ?? false,
    enforce: options.enforce ?? false,
    cost: options.cost ?? 0.001,
    fail: options.fail,
    // true: every answer is reasoning only and stops on its output limit. A
    // function (body) => boolean decides per request, so a test can make the
    // first request come back empty and a retry with a larger max_tokens or a
    // lower reasoning_effort answer.
    emptyLength: options.emptyLength ?? process.env.MOCK_GATEWAY_EMPTY_LENGTH === "1",
    // { name, arguments }: the first turn of a conversation asks for this tool
    // call; once a tool result is in the messages the canned reply follows.
    toolCall: options.toolCall,
    // A tool call on every turn instead of the first only: true asks for
    // toolCall whenever the last message is the user's, a function
    // (turn, messages) => { name, arguments } | undefined picks the call per
    // turn (turn counts the user messages, from 1).
    toolCallEach: options.toolCallEach,
    // true keeps every chat request body as received (bytes, parsed JSON and the session header) in `bodies`.
    bodies: options.bodies ?? false,
    prices: options.prices ?? MOCK_PRICES,
    usage: options.usage ?? USAGE,
    // { "rafiki-fast": "rafiki-pro" }: answer a request for the first on the
    // second, the way the gateway does after a fallback (every chunk names it).
    answeredBy: options.answeredBy,
  }
  // token -> { alias, models, max_budget, budget_duration, rpm_limit, tpm_limit, spend, metadata, deleted }
  const keys = new Map()
  const requests = []
  const bodies = []
  let url = ""

  function record(entry) {
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry })
    requests.push(entry)
    if (!opts.quiet) process.stderr.write(line + "\n")
    if (opts.log) fs.appendFileSync(opts.log, line + "\n")
  }

  function json(res, status, body, headers = {}) {
    res.writeHead(status, { "content-type": "application/json", ...headers })
    res.end(JSON.stringify(body))
  }

  // LiteLLM's error bodies: the condition lives in error.type.
  function gatewayError(res, status, type, message, param = null) {
    json(res, status, { error: { message, type, param, code: String(status) } })
  }

  function bearer(req) {
    const header = req.headers.authorization ?? ""
    const match = /^Bearer\s+(\S+)$/i.exec(header)
    return match?.[1]
  }

  function byAlias(alias) {
    for (const [token, key] of keys) if (key.alias === alias) return { token, key }
    return undefined
  }

  function publicKey(token, key) {
    return {
      token: "hashed-" + crypto.createHash("sha256").update(token).digest("hex").slice(0, 16),
      key_alias: key.alias,
      models: key.models,
      max_budget: key.max_budget,
      budget_duration: key.budget_duration,
      rpm_limit: key.rpm_limit,
      tpm_limit: key.tpm_limit,
      spend: key.spend,
      metadata: key.metadata,
      expires: key.expires,
    }
  }

  function readBody(req) {
    return new Promise((resolve) => {
      const parts = []
      req.on("data", (part) => parts.push(part))
      req.on("end", () => {
        const bytes = Buffer.concat(parts)
        try {
          const parsed = JSON.parse(bytes.toString("utf8") || "{}")
          if (opts.bodies && req.url?.startsWith("/v1/chat/completions")) bodies.push({ raw: bytes, json: parsed, session: req.headers["x-session-id"] })
          resolve(parsed)
        } catch {
          resolve(undefined)
        }
      })
    })
  }

  function completion(model, text, empty) {
    return {
      id: "chatcmpl-mock-" + Date.now(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        empty
          ? { index: 0, message: { role: "assistant", content: "", reasoning_content: "Planning the answer..." }, finish_reason: "length" }
          : { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
      ],
      usage: opts.usage,
    }
  }

  function stream(res, model, text, headers, empty) {
    const id = "chatcmpl-mock-" + Date.now()
    const created = Math.floor(Date.now() / 1000)
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...headers,
    })
    const chunk = (delta, finish) =>
      "data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n"
    res.write(chunk({ role: "assistant", content: "" }, null))
    if (empty) {
      res.write(chunk({ reasoning_content: "Planning the answer..." }, null))
      res.write(chunk({}, "length"))
    } else {
      for (const word of text.split(" ")) res.write(chunk({ content: word + " " }, null))
      res.write(chunk({}, "stop"))
    }
    res.write(
      "data: " +
        JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: opts.usage }) +
        "\n\n",
    )
    res.write("data: [DONE]\n\n")
    res.end()
  }

  // The checks the real gateway makes on a chat call, in its order.
  function authorize(req, model) {
    const token = bearer(req)
    const enforce = opts.enforce || keys.size > 0
    if (opts.fail === "revoked") return { status: 401, type: "auth_error", message: "Authentication Error, Invalid proxy server token passed. token_not_found_in_db" }
    if (opts.fail === "budget") return { status: 429, type: "budget_exceeded", message: "Budget has been exceeded! Current cost: 0.0026, Max budget: 0.0025" }
    if (opts.fail === "denied") return { status: 403, type: "key_model_access_denied", message: `key not allowed to access model. This key can only access models=['rafiki-fast']. Tried to access ${model}`, param: "model" }
    if (opts.fail === "down") return { status: 503, type: "api_error", message: "Service Unavailable" }
    if (opts.fail === "rate") return { status: 429, type: "rate_limit_error", message: "Rate limit exceeded", headers: { "retry-after": "7" } }
    if (!enforce) return { key: undefined }
    const key = token ? keys.get(token) : undefined
    if (!key || key.deleted) return { status: 401, type: "auth_error", message: "Authentication Error, Invalid proxy server token passed. token_not_found_in_db" }
    if (!key.models.includes(model)) {
      return { status: 403, type: "key_model_access_denied", message: `key not allowed to access model. This key can only access models=${JSON.stringify(key.models)}. Tried to access ${model}`, param: "model" }
    }
    if (key.max_budget !== null && key.spend >= key.max_budget) {
      return { status: 429, type: "budget_exceeded", message: `Budget has been exceeded! Current cost: ${key.spend}, Max budget: ${key.max_budget}` }
    }
    return { key }
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", `http://${req.headers.host}`)
    const auth = req.headers.authorization ? "present" : "missing"
    const surface = req.headers["x-rafiki-surface"]
    const tier = req.headers["x-rafiki-tier"]
    const escalation = req.headers["x-rafiki-escalation"]

    // LiteLLM's liveness probe: a bare string body, no auth. rafikicode doctor reads it.
    if (req.method === "GET" && u.pathname === "/health/liveliness") {
      record({ method: req.method, path: u.pathname, status: opts.fail === "down" ? 503 : 200 })
      if (opts.fail === "down") return json(res, 503, { error: { message: "Service Unavailable" } })
      return json(res, 200, "I'm alive!")
    }

    if (req.method === "GET" && u.pathname === "/v1/models") {
      record({ method: req.method, path: u.pathname, authorization: auth, surface })
      const token = bearer(req)
      const key = token ? keys.get(token) : undefined
      const list = key && !key.deleted ? key.models : MODELS
      return json(res, 200, { object: "list", data: list.map((id) => ({ id, object: "model", created: 0, owned_by: "rafiki" })) })
    }

    if (req.method === "GET" && u.pathname === "/v1/model/info") {
      const token = bearer(req)
      const key = token ? keys.get(token) : undefined
      const status = opts.prices === false ? 404 : !token ? 401 : 200
      record({ method: req.method, path: u.pathname, authorization: auth, surface, status })
      if (status === 404) return json(res, 404, { error: { message: "not found" } })
      if (status === 401) return gatewayError(res, 401, "auth_error", "Authentication Error: no bearer token")
      const list = key && !key.deleted ? key.models : MODELS
      return json(res, 200, {
        data: list
          .filter((id) => opts.prices[id])
          .map((id) => ({ model_name: id, litellm_params: { model: "mock/" + id, ...opts.prices[id] }, model_info: { id: "mock-" + id } })),
      })
    }

    if (req.method === "POST" && u.pathname === "/v1/chat/completions") {
      const body = await readBody(req)
      if (!body) return json(res, 400, { error: { message: "invalid JSON body" } })
      const model = typeof body.model === "string" ? body.model : "unknown"
      const messages = Array.isArray(body.messages) ? body.messages : []
      const last = messages.at(-1)
      const token = bearer(req)
      const check = authorize(req, model)
      record({
        method: req.method,
        path: u.pathname,
        authorization: auth,
        key_alias: token && keys.get(token)?.alias,
        surface,
        tier,
        escalation,
        ua: req.headers["user-agent"],
        model,
        stream: body.stream === true,
        messages: messages.length,
        tools: Array.isArray(body.tools) ? body.tools.length : 0,
        max_tokens: body.max_tokens ?? body.max_completion_tokens,
        reasoning_effort: body.reasoning_effort,
        last_user: typeof last?.content === "string" ? last.content.slice(0, 120) : undefined,
        status: check.status ?? 200,
        error_type: check.type,
      })
      if (check.status) return gatewayError(res, check.status, check.type, check.message, check.param ?? null)
      if (!MODELS.includes(model)) return json(res, 404, { error: { message: `unknown model ${model}` } })
      const headers = {}
      if (check.key) {
        check.key.spend = Math.round((check.key.spend + opts.cost) * 1e6) / 1e6
        headers["x-litellm-response-cost"] = String(opts.cost)
      }
      let wanted = opts.toolCall && !opts.toolCallEach && !messages.some((m) => m && m.role === "tool") ? opts.toolCall : undefined
      let callId = "call_mock_1"
      if (opts.toolCallEach && messages[messages.length - 1]?.role === "user") {
        const turn = messages.filter((m) => m && m.role === "user").length
        wanted = typeof opts.toolCallEach === "function" ? opts.toolCallEach(turn, messages) : opts.toolCall
        callId = `call_mock_${turn}`
      }
      if (wanted) {
        const call = { id: callId, type: "function", function: { name: wanted.name, arguments: JSON.stringify(wanted.arguments ?? {}) } }
        if (body.stream !== true) {
          return json(res, 200, {
            id: "chatcmpl-mock-" + Date.now(),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }],
            usage: opts.usage,
          }, headers)
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...headers })
        const id = "chatcmpl-mock-" + Date.now()
        const created = Math.floor(Date.now() / 1000)
        const send = (delta, finish) =>
          res.write("data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n")
        send({ role: "assistant", content: null, tool_calls: [{ index: 0, ...call }] }, null)
        send({}, "tool_calls")
        res.write("data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: opts.usage }) + "\n\n")
        res.write("data: [DONE]\n\n")
        return res.end()
      }
      // A fallback: the gateway answers on another tier and names it in the body.
      const answered = opts.answeredBy?.[model] ?? model
      const empty = typeof opts.emptyLength === "function" ? Boolean(opts.emptyLength(body)) : Boolean(opts.emptyLength)
      if (body.stream === true) return stream(res, answered, opts.reply, headers, empty)
      return json(res, 200, completion(answered, opts.reply, empty), headers)
    }

    // Admin half. The real gateway wants the master key; the mock only wants a bearer.
    if (u.pathname.startsWith("/key/") && !bearer(req)) {
      record({ method: req.method, path: u.pathname, status: 401 })
      return gatewayError(res, 401, "auth_error", "Authentication Error: no bearer token")
    }

    if (req.method === "POST" && u.pathname === "/key/generate") {
      const body = (await readBody(req)) ?? {}
      const token = "sk-mock-" + crypto.randomBytes(12).toString("hex")
      const key = {
        alias: body.key_alias ?? null,
        models: Array.isArray(body.models) ? body.models : MODELS,
        max_budget: typeof body.max_budget === "number" ? body.max_budget : null,
        budget_duration: body.budget_duration ?? null,
        rpm_limit: body.rpm_limit ?? null,
        tpm_limit: body.tpm_limit ?? null,
        spend: 0,
        metadata: body.metadata ?? {},
        expires: body.duration ? new Date(Date.now() + 30 * 86400_000).toISOString() : null,
        deleted: false,
      }
      keys.set(token, key)
      record({ method: req.method, path: u.pathname, key_alias: key.alias, models: key.models, max_budget: key.max_budget, duration: body.duration, metadata: key.metadata })
      return json(res, 200, { key: token, ...publicKey(token, key) })
    }

    if (req.method === "GET" && u.pathname === "/key/info") {
      const token = bearer(req)
      const key = keys.get(token)
      record({ method: req.method, path: u.pathname, key_alias: key?.alias, status: key && !key.deleted ? 200 : 401 })
      if (!key || key.deleted) return gatewayError(res, 401, "auth_error", "Authentication Error, Invalid proxy server token passed. token_not_found_in_db")
      return json(res, 200, { key: publicKey(token, key).token, info: publicKey(token, key) })
    }

    if (req.method === "GET" && u.pathname === "/key/list") {
      const alias = u.searchParams.get("key_alias")
      const found = alias ? byAlias(alias) : undefined
      record({ method: req.method, path: u.pathname, key_alias: alias, found: Boolean(found && !found.key.deleted) })
      return json(res, 200, { keys: found && !found.key.deleted ? [publicKey(found.token, found.key)] : [] })
    }

    if (req.method === "POST" && u.pathname === "/key/update") {
      const body = (await readBody(req)) ?? {}
      let hit
      for (const [token, key] of keys) {
        if (publicKey(token, key).token === body.key || token === body.key) hit = { token, key }
      }
      record({ method: req.method, path: u.pathname, key_alias: hit?.key.alias, max_budget: body.max_budget, status: hit ? 200 : 404 })
      if (!hit) return gatewayError(res, 404, "not_found_error", "key not found")
      if (typeof body.max_budget === "number") hit.key.max_budget = body.max_budget
      return json(res, 200, publicKey(hit.token, hit.key))
    }

    if (req.method === "POST" && u.pathname === "/key/delete") {
      const body = (await readBody(req)) ?? {}
      const deleted = []
      for (const alias of body.key_aliases ?? []) {
        const found = byAlias(alias)
        if (found) {
          found.key.deleted = true
          deleted.push(alias)
        }
      }
      record({ method: req.method, path: u.pathname, deleted })
      return json(res, 200, { deleted_keys: deleted })
    }

    // Test hooks: inspect or change the mock's memory without the admin protocol.
    if (req.method === "GET" && u.pathname === "/__test/keys") {
      return json(res, 200, [...keys].map(([token, key]) => ({ token, ...publicKey(token, key), deleted: key.deleted })))
    }
    // Register a key minted elsewhere (the mock Console mints its own), so the
    // chat half enforces it as if /key/generate had made it.
    if (req.method === "POST" && u.pathname === "/__test/register") {
      const body = (await readBody(req)) ?? {}
      keys.set(body.key, {
        alias: body.key_alias ?? null,
        models: Array.isArray(body.models) ? body.models : MODELS,
        max_budget: typeof body.max_budget === "number" ? body.max_budget : null,
        budget_duration: null,
        rpm_limit: 60,
        tpm_limit: 200000,
        spend: 0,
        metadata: body.metadata ?? {},
        expires: null,
        deleted: false,
      })
      return json(res, 200, { ok: true })
    }
    if (req.method === "POST" && u.pathname === "/__test/spend") {
      const body = (await readBody(req)) ?? {}
      const found = byAlias(body.key_alias)
      if (found) found.key.spend = body.spend
      return json(res, 200, { ok: Boolean(found) })
    }

    record({ method: req.method, path: u.pathname, status: 404 })
    json(res, 404, { error: { message: "not found" } })
  })

  const ready = new Promise((resolve) => {
    server.listen(opts.port, "127.0.0.1", () => {
      url = `http://127.0.0.1:${server.address().port}`
      if (!opts.quiet) process.stderr.write(`mock gateway listening on ${url}/v1\n`)
      resolve(url)
    })
  })

  return {
    ready,
    get url() {
      return url
    },
    requests,
    bodies,
    keys,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const env = process.env
  createMockGateway({
    port: Number(process.argv[2] ?? env.MOCK_GATEWAY_PORT ?? 4180),
    reply: env.MOCK_GATEWAY_REPLY,
    log: env.MOCK_GATEWAY_LOG,
    enforce: env.MOCK_GATEWAY_ENFORCE === "1",
    cost: env.MOCK_GATEWAY_COST ? Number(env.MOCK_GATEWAY_COST) : undefined,
    fail: env.MOCK_GATEWAY_FAIL,
  })
}
