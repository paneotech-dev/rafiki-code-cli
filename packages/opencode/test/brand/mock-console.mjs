#!/usr/bin/env node
// Mock of the Rafiki Console device flow for local checks and tests. Speaks
// the shapes in platform/docs/rafiki-code-contract-v1.md: device code
// issuance, the token endpoint with every documented outcome, the account
// route, key revocation, and key rotation. Test hooks under /__test/ stand in
// for the browser approval page. Nothing here talks to a real service.
//
//   node test/brand/mock-console.mjs [port]           (default 4181)
//   MOCK_CONSOLE_INTERVAL=1        polling interval in seconds (default 5)
//   MOCK_CONSOLE_EXPIRES=600       code lifetime in seconds
//   MOCK_CONSOLE_AUTO=approve|deny|expire   act after MOCK_CONSOLE_AUTO_AFTER polls (default 2)
//   MOCK_CONSOLE_SLOW_DOWN_ONCE=1  answer slow_down on the first poll of every code
//   MOCK_CONSOLE_RATE_LIMIT_ONCE=1 answer 429 with Retry-After on the first poll of every code
//   MOCK_CONSOLE_UNAVAILABLE=1     answer 503 on the token endpoint
//   MOCK_CONSOLE_LOG=/path.jsonl   append one JSON line per request
import http from "node:http"
import fs from "node:fs"
import crypto from "node:crypto"

const ALPHABET = "BCDFGHJKMNPQRSTVWXZ"
const SLOW_DOWN_INCREMENT = 5
const SESSION_TTL = 30 * 24 * 3600

const TYPES = {
  invalid_request: "invalid_request_error",
  unknown_client: "invalid_request_error",
  authorization_pending: "authorization_pending",
  slow_down: "slow_down",
  access_denied: "access_denied",
  expired_token: "expired_token",
  invalid_grant: "invalid_grant",
  unsupported_grant_type: "unsupported_grant_type",
  rate_limited: "rate_limit_error",
  service_unavailable: "api_error",
  unauthenticated: "authentication_error",
  key_revoked: "authentication_error",
  wrong_key_kind: "invalid_request_error",
  not_found: "invalid_request_error",
}
const RETRYABLE = new Set(["authorization_pending", "slow_down", "rate_limited", "service_unavailable"])
const MESSAGES = {
  invalid_request: "That request was not understood.",
  unknown_client: "Unknown client.",
  authorization_pending: "Waiting for approval in the browser.",
  slow_down: "Polling too fast. Wait longer between requests.",
  access_denied: "Sign-in was denied in the browser.",
  expired_token: "That sign-in code expired. Run rafikicode login again.",
  invalid_grant: "That sign-in code is not valid.",
  unsupported_grant_type: "Only the device authorization grant is supported here.",
  rate_limited: "Too many requests. Try again shortly.",
  service_unavailable: "The service is not available.",
  unauthenticated: "Missing API key. Run rafikicode login, or set RAFIKICODE_API_KEY.",
  key_revoked: "This key was revoked or has expired. Run rafikicode login.",
  wrong_key_kind: "This key cannot be refreshed here. Create a new key at console.rafikiai.io/keys.",
  not_found: "No such key.",
}

function userCode() {
  const bytes = crypto.randomBytes(8)
  let out = ""
  for (let i = 0; i < 8; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out.slice(0, 4) + "-" + out.slice(4)
}

function normalize(code) {
  return String(code ?? "").toUpperCase().replace(/-/g, "")
}

export function createMockConsole(options = {}) {
  const opts = {
    port: options.port ?? 0,
    interval: options.interval ?? 5,
    expiresIn: options.expiresIn ?? 600,
    auto: options.auto ?? "none",
    autoAfter: options.autoAfter ?? 2,
    slowDownOnce: options.slowDownOnce ?? false,
    rateLimitOnce: options.rateLimitOnce ?? false,
    unavailable: options.unavailable ?? false,
    log: options.log,
    quiet: options.quiet ?? false,
    gatewayURL: options.gatewayURL ?? "https://gateway.rafikiai.io/v1",
    owner: options.owner ?? { id: "usr_mock", email: "jane@example.com", name: "Jane" },
    // Injectable clock so in-process tests can drive polling without waiting.
    now: options.now ?? (() => Date.now()),
  }
  const codes = new Map()
  const byUserCode = new Map()
  const keys = new Map()
  const requests = []
  let url = ""

  function record(entry) {
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry })
    requests.push(entry)
    if (!opts.quiet) process.stderr.write(line + "\n")
    if (opts.log) fs.appendFileSync(opts.log, line + "\n")
  }

  function json(res, status, body, headers = {}) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers })
    res.end(JSON.stringify(body))
  }

  function error(res, status, code, headers = {}, message = MESSAGES[code]) {
    json(res, status, { error: { message, type: TYPES[code], code, retryable: RETRYABLE.has(code) } }, headers)
  }

  function mint(label, tiers) {
    const id = crypto.randomUUID()
    const key = "sk-mock-" + crypto.randomBytes(24).toString("base64url")
    const alias = "rafikicode-" + crypto.randomUUID()
    const record = { id, key, alias, label, tiers, kind: "session", created: opts.now(), revoked: false }
    keys.set(key, record)
    return record
  }

  function tokenBody(k) {
    return {
      access_token: k.key,
      token_type: "bearer",
      expires_in: SESSION_TTL,
      scope: [...k.tiers.map((t) => "rafiki-" + t), "console:me"].join(" "),
      key_id: k.id,
      key_alias: k.alias,
      gateway_url: opts.gatewayURL,
      console_url: url,
      owner: opts.owner,
      limits: { max_budget_usd: 2.5, budget_duration: null, rpm_limit: 60, tpm_limit: 200000 },
    }
  }

  function bearer(req) {
    const header = req.headers.authorization ?? ""
    const match = /^Bearer\s+(.+)$/i.exec(header)
    if (!match) return undefined
    return keys.get(match[1].trim())
  }

  function approve(code, tiers) {
    const entry = byUserCode.get(normalize(code))
    if (!entry || entry.status !== "pending") return false
    entry.status = "approved"
    entry.key = mint(entry.label, tiers ?? entry.tiers)
    return true
  }
  function deny(code) {
    const entry = byUserCode.get(normalize(code))
    if (!entry || entry.status !== "pending") return false
    entry.status = "denied"
    return true
  }
  function expire(code) {
    const entry = byUserCode.get(normalize(code))
    if (!entry) return false
    entry.expiresAt = 0
    return true
  }

  async function body(req) {
    let raw = ""
    for await (const part of req) raw += part
    if (!raw) return {}
    const type = req.headers["content-type"] ?? ""
    if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw))
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", `http://${req.headers.host}`)
    const path = u.pathname
    const method = req.method

    if (method === "POST" && path === "/api/v1/device/code") {
      const data = await body(req)
      record({ method, path, client_id: data?.client_id, surface: data?.surface, label: data?.device_label })
      if (!data) return error(res, 400, "invalid_request")
      if (data.client_id !== "rafikicode") return error(res, 400, "unknown_client")
      if (!["cli", "ide"].includes(data.surface)) return error(res, 400, "invalid_request", {}, "That request was not understood: surface.")
      if (typeof data.device_label !== "string" || !data.device_label.trim() || data.device_label.length > 120) {
        return error(res, 400, "invalid_request", {}, "That request was not understood: device_label.")
      }
      const tiers = Array.isArray(data.requested_tiers) ? data.requested_tiers : ["fast", "pro", "max"]
      const deviceCode = crypto.randomBytes(32).toString("base64url")
      const shown = userCode()
      const entry = {
        deviceCode,
        userCode: shown,
        status: "pending",
        polls: 0,
        lastPolledAt: 0,
        acceptedInterval: opts.interval,
        expiresAt: opts.now() + opts.expiresIn * 1000,
        label: data.device_label,
        tiers,
        key: undefined,
      }
      codes.set(deviceCode, entry)
      byUserCode.set(normalize(shown), entry)
      return json(res, 200, {
        device_code: deviceCode,
        user_code: shown,
        verification_uri: `${url}/device`,
        verification_uri_complete: `${url}/device?code=${encodeURIComponent(shown)}`,
        expires_in: opts.expiresIn,
        interval: opts.interval,
      })
    }

    if (method === "POST" && path === "/api/v1/device/token") {
      const data = await body(req)
      const entry = data?.device_code ? codes.get(data.device_code) : undefined
      record({ method, path, grant_type: data?.grant_type, known_code: Boolean(entry), status: entry?.status })
      if (opts.unavailable) return error(res, 503, "service_unavailable")
      if (!data) return error(res, 400, "invalid_request")
      if (data.grant_type !== "urn:ietf:params:oauth:grant-type:device_code") return error(res, 400, "unsupported_grant_type")
      if (!entry || data.client_id !== "rafikicode") return error(res, 400, "invalid_grant")
      const now = opts.now()
      entry.polls += 1
      if (entry.polls === 1 && opts.rateLimitOnce) return error(res, 429, "rate_limited", { "retry-after": "1" })
      if (now > entry.expiresAt) {
        entry.status = "expired"
        return error(res, 400, "expired_token")
      }
      const tooSoon = entry.lastPolledAt && now - entry.lastPolledAt < entry.acceptedInterval * 1000 - 50
      const forced = entry.polls === 1 && opts.slowDownOnce
      entry.lastPolledAt = now
      if (tooSoon || forced) {
        entry.acceptedInterval += SLOW_DOWN_INCREMENT
        return error(res, 400, "slow_down", { "retry-after": String(entry.acceptedInterval) })
      }
      if (entry.status === "pending" && opts.auto !== "none" && entry.polls >= opts.autoAfter) {
        if (opts.auto === "approve") approve(entry.userCode)
        if (opts.auto === "deny") deny(entry.userCode)
        if (opts.auto === "expire") {
          entry.status = "expired"
          return error(res, 400, "expired_token")
        }
      }
      if (entry.status === "pending") return error(res, 400, "authorization_pending", { "retry-after": String(entry.acceptedInterval) })
      if (entry.status === "denied") return error(res, 400, "access_denied")
      if (entry.status === "approved") {
        entry.status = "consumed"
        return json(res, 200, tokenBody(entry.key))
      }
      return error(res, 400, "expired_token")
    }

    if (method === "GET" && path === "/api/v1/me") {
      const k = bearer(req)
      record({ method, path, authorization: req.headers.authorization ? "present" : "missing", known_key: Boolean(k) })
      if (!k) return error(res, 401, "unauthenticated")
      if (k.revoked) return error(res, 401, "key_revoked")
      return json(res, 200, {
        object: "me",
        owner: opts.owner,
        key: {
          id: k.id,
          alias: k.alias,
          name: k.label,
          kind: k.kind,
          created_at: new Date(k.created).toISOString(),
          expires_at: new Date(k.created + SESSION_TTL * 1000).toISOString(),
        },
        wallet: { balance_usd: 12.4, credited_usd: 20, spent_usd: 7.6 },
        limits: { max_budget_usd: 2.5, spend_usd: 0.31, budget_duration: null, rpm_limit: 60, tpm_limit: 200000 },
        tiers: k.tiers,
      })
    }

    if (method === "DELETE" && path.startsWith("/api/v1/keys/")) {
      const id = decodeURIComponent(path.slice("/api/v1/keys/".length))
      const k = bearer(req)
      record({ method, path: "/api/v1/keys/:id", authorization: req.headers.authorization ? "present" : "missing", known_key: Boolean(k) })
      if (!k || k.revoked) return error(res, 401, k ? "key_revoked" : "unauthenticated")
      const target = [...keys.values()].find((item) => item.id === id)
      if (!target) return error(res, 404, "not_found")
      target.revoked = true
      return json(res, 200, { id: target.id, object: "api_key", revoked: true })
    }

    if (method === "POST" && path === "/api/v1/device/refresh") {
      const k = bearer(req)
      record({ method, path, authorization: req.headers.authorization ? "present" : "missing", known_key: Boolean(k) })
      if (!k || k.revoked) return error(res, 401, k ? "key_revoked" : "unauthenticated")
      if (k.kind !== "session") return error(res, 400, "wrong_key_kind")
      const next = mint(k.label, k.tiers)
      k.revoked = true
      return json(res, 200, tokenBody(next))
    }

    // Test hooks standing in for the approval page.
    if (path.startsWith("/__test/")) {
      const data = method === "POST" ? await body(req) : {}
      const action = path.slice("/__test/".length)
      record({ method, path, action })
      if (action === "state") {
        return json(res, 200, {
          codes: [...codes.values()].map((c) => ({ user_code: c.userCode, status: c.status, polls: c.polls })),
          keys: [...keys.values()].map((k) => ({ id: k.id, alias: k.alias, revoked: k.revoked })),
        })
      }
      if (action === "approve") return json(res, approve(data?.user_code, data?.tiers) ? 200 : 409, { ok: true })
      if (action === "deny") return json(res, deny(data?.user_code) ? 200 : 409, { ok: true })
      if (action === "expire") return json(res, expire(data?.user_code) ? 200 : 409, { ok: true })
      return json(res, 404, { error: { message: "unknown test hook" } })
    }

    record({ method, path, status: 404 })
    return error(res, 404, "not_found", {}, "No such route.")
  })

  const listening = new Promise((resolve) => {
    server.listen(opts.port, "127.0.0.1", () => {
      const address = server.address()
      url = `http://127.0.0.1:${address.port}`
      if (!opts.quiet) process.stderr.write(`mock console listening on ${url}\n`)
      resolve(url)
    })
  })

  return {
    server,
    ready: listening,
    get url() {
      return url
    },
    requests,
    keys,
    codes,
    approve,
    deny,
    expire,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const env = process.env
  createMockConsole({
    port: Number(process.argv[2] ?? env.MOCK_CONSOLE_PORT ?? 4181),
    interval: env.MOCK_CONSOLE_INTERVAL ? Number(env.MOCK_CONSOLE_INTERVAL) : undefined,
    expiresIn: env.MOCK_CONSOLE_EXPIRES ? Number(env.MOCK_CONSOLE_EXPIRES) : undefined,
    auto: env.MOCK_CONSOLE_AUTO,
    autoAfter: env.MOCK_CONSOLE_AUTO_AFTER ? Number(env.MOCK_CONSOLE_AUTO_AFTER) : undefined,
    slowDownOnce: env.MOCK_CONSOLE_SLOW_DOWN_ONCE === "1",
    rateLimitOnce: env.MOCK_CONSOLE_RATE_LIMIT_ONCE === "1",
    unavailable: env.MOCK_CONSOLE_UNAVAILABLE === "1",
    log: env.MOCK_CONSOLE_LOG,
  })
}
