// The tokens per minute safety net (src/rafiki/tpm.ts): which 429 means the
// request alone is over the key's limit, the estimate of the next request,
// the limit read from /key/info, and how the provider error parser turns such
// a refusal into a context overflow while an ordinary 429 keeps its backoff.
import { afterEach, describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import * as Account from "@opencode-ai/core/brand/account"
import { Brand } from "@opencode-ai/core/brand/brand"
import { ProviderV2 } from "@opencode-ai/core/provider"
import * as Tpm from "../../src/rafiki/tpm"
import { ProviderError } from "../../src/provider/error"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import * as Doctor from "../../src/rafiki/doctor"

const refusal = (limit: number, remaining: number) =>
  `Rate limit exceeded for api_key: hashed-1234. Limit type: tokens. Current limit: ${limit}, Remaining: ${remaining}. Limit resets at: 2026-10-12 10:01:00 UTC`

function apiError(status: number, message: string, headers: Record<string, string> = {}) {
  return new APICallError({
    message,
    url: "https://gateway.rafikiai.io/v1/chat/completions",
    requestBodyValues: {},
    statusCode: status,
    responseHeaders: headers,
    responseBody: JSON.stringify({ error: { message, type: "None", param: "None", code: String(status) } }),
    isRetryable: status === 429,
  })
}

const rafiki = ProviderV2.ID.make(Brand.provider.id)

afterEach(() => {
  Tpm.reset()
  Account.resetKeyInfoCache()
})

describe("a 429 over the tokens per minute limit", () => {
  test("is oversized when Remaining is at or near the full limit", () => {
    expect(Tpm.oversized({ statusCode: 429, message: refusal(200000, 200000) })).toBe(200000)
    expect(Tpm.oversized({ statusCode: 429, responseBody: JSON.stringify({ error: { message: refusal(200000, 195000) } }) })).toBe(200000)
    expect(Tpm.oversized({ statusCode: 429, message: refusal(2_000_000, 2_000_000) })).toBe(2_000_000)
  })

  test("is not oversized when earlier requests used the minute, for a request limit, or another status", () => {
    expect(Tpm.oversized({ statusCode: 429, message: refusal(200000, 1200) })).toBeUndefined()
    expect(
      Tpm.oversized({ statusCode: 429, message: "Rate limit exceeded. Limit type: requests. Current limit: 60, Remaining: 60" }),
    ).toBeUndefined()
    expect(Tpm.oversized({ statusCode: 500, message: refusal(200000, 200000) })).toBeUndefined()
    expect(Tpm.oversized({ statusCode: 429, message: "Rate limit exceeded" })).toBeUndefined()
  })

  test("becomes a context overflow for the Rafiki provider, so the session compacts instead of waiting", () => {
    const parsed = ProviderError.parseAPICallError({ providerID: rafiki, error: apiError(429, refusal(200000, 200000)) })
    expect(parsed.type).toBe("context_overflow")
    expect(Tpm.isOverflow(parsed.message)).toBe(true)
    const error = MessageV2.fromError(apiError(429, refusal(200000, 200000)), { providerID: rafiki })
    expect(error.name).toBe("ContextOverflowError")
    expect(SessionRetry.retryable(error as SessionRetry.Err, rafiki)).toBeUndefined()
  })

  test("an ordinary 429 keeps the backoff, with the wait the gateway asks for", () => {
    for (const message of [refusal(200000, 1200), "Rate limit exceeded. Limit type: requests. Current limit: 60, Remaining: 0"]) {
      const error = MessageV2.fromError(apiError(429, message, { "retry-after": "7" }), { providerID: rafiki })
      expect(error.name).toBe("APIError")
      expect(SessionRetry.retryable(error as SessionRetry.Err, rafiki)?.message).toBe("Too many requests. Try again in 7 seconds.")
      expect(SessionRetry.delay(1, error as any)).toBe(7000)
    }
  })

  test("the limit named in the refusal is remembered", async () => {
    ProviderError.parseAPICallError({ providerID: rafiki, error: apiError(429, refusal(150000, 150000)) })
    expect(await Tpm.limit(async () => ({ ok: false, at: Date.now() }))).toBe(150000)
  })
})

describe("the limit and the estimate", () => {
  test("the limit comes from the key's /key/info answer", async () => {
    const info = Account.parseKeyInfo({ info: { spend: 1, max_budget: 5, models: [], tpm_limit: 2_000_000, rpm_limit: 1000 } })
    expect(info).toMatchObject({ tpmLimit: 2_000_000, rpmLimit: 1000 })
    expect(Account.parseKeyInfo({ info: { spend: 1, tpm_limit: null } })?.tpmLimit).toBeUndefined()
    expect(await Tpm.limit(async () => ({ ok: true, info: info!, at: Date.now() }))).toBe(2_000_000)
    expect(await Tpm.limit(async () => ({ ok: false, at: Date.now() }))).toBeUndefined()
  })

  test("the key reading is shared and kept, and a failed one is not asked again at once", async () => {
    let calls = 0
    const fetch = (async () => {
      calls++
      return new Response(JSON.stringify({ info: { spend: 0, tpm_limit: 300000 } }), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const prev = process.env[Brand.env.apiKey]
    const prevURL = process.env[Brand.env.gatewayURL]
    process.env[Brand.env.apiKey] = "sk-tpm-test"
    process.env[Brand.env.gatewayURL] = "http://127.0.0.1:9/v1"
    try {
      const [a, b] = await Promise.all([Account.cachedKeyInfo({ fetch }), Account.cachedKeyInfo({ fetch })])
      expect(a.ok && a.info.tpmLimit).toBe(300000)
      expect(b).toBe(a)
      await Account.cachedKeyInfo({ fetch })
      expect(calls).toBe(1)
      Account.resetKeyInfoCache()
      const failing = (async () => {
        calls++
        return new Response("no", { status: 500 })
      }) as unknown as typeof globalThis.fetch
      expect((await Account.cachedKeyInfo({ fetch: failing })).ok).toBe(false)
      await Account.cachedKeyInfo({ fetch: failing })
      expect(calls).toBe(2)
    } finally {
      if (prev === undefined) delete process.env[Brand.env.apiKey]
      else process.env[Brand.env.apiKey] = prev
      if (prevURL === undefined) delete process.env[Brand.env.gatewayURL]
      else process.env[Brand.env.gatewayURL] = prevURL
    }
  })

  test("the next request is the previous one plus what was added since", () => {
    const tokens = { input: 150_000, output: 2_000, reasoning: 0, cache: { read: 30_000, write: 0 } }
    const messages = [
      { info: { id: "a" }, parts: [{ type: "text", text: "x".repeat(400) }] },
      {
        info: { id: "b" },
        parts: [
          { type: "text", text: "answer" },
          { type: "tool", state: { status: "completed", output: "y".repeat(40_000) } },
        ],
      },
      { info: { id: "c" }, parts: [{ type: "text", text: "z".repeat(4_000) }] },
    ]
    expect(Tpm.estimate(messages, { id: "b", tokens })).toBe(182_000 + 10_000 + 1_000)
    expect(Tpm.over(193_000, 200_000)).toBe(true)
    expect(Tpm.over(170_000, 200_000)).toBe(false)
    expect(Tpm.over(193_000, undefined)).toBe(false)
  })

  test("the compaction input is cut from the start to fit under the limit", () => {
    const text = "a".repeat(1_000_000) + "END"
    const cut = Tpm.fit(text, 200_000)
    expect(cut.length).toBeLessThan((200_000 * 0.9 - 8_000) * 4 + 200)
    expect(cut.endsWith("END")).toBe(true)
    expect(cut.startsWith("[Earlier conversation omitted")).toBe(true)
    expect(Tpm.fit("short", 200_000)).toBe("short")
    expect(Tpm.fit(text, undefined)).toBe(text)
  })

  test("the lines say why, without a dash", () => {
    expect(Tpm.beforeLine(185_000, 200_000)).toBe(
      "Compacting the session first: the next request is about 185,000 tokens, near this key's limit of 200,000 tokens per minute.",
    )
    expect(Tpm.isNotice(Tpm.refusedLine(200_000))).toBe(true)
    expect(Tpm.stillTooLarge(200_000)).toContain("200,000 tokens per minute, even after compacting")
  })
})

describe("doctor", () => {
  test("shows the key's requests and tokens per minute", () => {
    expect(Doctor.checkLimits({ rpm_limit: 1000, tpm_limit: 2_000_000 })).toEqual({
      name: "limits",
      status: "ok",
      detail: "1,000 requests per minute, 2,000,000 tokens per minute",
    })
    expect(Doctor.checkLimits({ rpm_limit: null }).detail).toBe("no requests per minute limit, no tokens per minute limit")
  })
})
