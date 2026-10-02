// The cost display's inputs and its end of task line: the price list from the
// mock gateway, the balance from the mock console, what happens when either
// is missing, and the line a real rafikicode run prints.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import * as Account from "@opencode-ai/core/brand/account"
import * as Cost from "@opencode-ai/core/brand/cost"
import * as RafikiCost from "../../src/rafiki/cost"
import { createMockConsole } from "../brand/mock-console.mjs"
import { createMockGateway, MOCK_PRICES } from "../brand/mock-gateway.mjs"
import { spawnCli } from "./spawn"

const KEY = "sk-test-not-a-real-key"
// What the mock gateway reports for every answer: 10,000 prompt tokens of
// which 6,000 were read from the cache, 2,000 completion tokens.
const USAGE = { prompt_tokens: 10_000, completion_tokens: 2_000, total_tokens: 12_000, prompt_tokens_details: { cached_tokens: 6_000 } }

let home: string
let console_: ReturnType<typeof createMockConsole> | undefined
let gateway: ReturnType<typeof createMockGateway> | undefined

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-cost-"))
})

afterEach(async () => {
  await console_?.close()
  await gateway?.close()
  console_ = undefined
  gateway = undefined
  fs.rmSync(home, { recursive: true, force: true })
})

async function mocks(options: { gateway?: Record<string, unknown>; console?: Record<string, unknown> } = {}) {
  gateway = createMockGateway({ quiet: true, usage: USAGE, ...options.gateway })
  console_ = createMockConsole({ quiet: true, anyKey: true, ...options.console })
  await Promise.all([gateway.ready, console_.ready])
  return { key: KEY, consoleURL: console_.url, gatewayURL: gateway.url + "/v1" }
}

describe("the price list and the balance", () => {
  test("the price list is read from the gateway's model info, per million tokens", async () => {
    const source = await mocks()
    const prices = await Account.prices(source)
    expect(prices).toEqual({
      fast: { input: 1, output: 2, cacheRead: 0.1 },
      pro: { input: 4, output: 8, cacheRead: 1 },
      max: { input: 10, output: 20, cacheRead: 1, cacheWrite: 12.5 },
    })
    const call = gateway!.requests.find((r: any) => r.path === "/v1/model/info") as any
    expect(call).toMatchObject({ authorization: "present", surface: "cli", status: 200 })
  })

  test("the balance is read from the account route", async () => {
    const source = await mocks({ console: { balance: 3.25 } })
    expect(await Account.balance(source)).toBe(3.25)
  })

  test("a snapshot takes both readings once", async () => {
    const source = await mocks()
    const snapshot = await Account.snapshot({ source, now: () => 1234 })
    expect(snapshot.balance).toBe(12.4)
    expect(snapshot.prices?.fast).toEqual({ input: 1, output: 2, cacheRead: 0.1 })
    expect(snapshot.at).toBe(1234)
    expect(gateway!.requests.filter((r: any) => r.path === "/v1/model/info")).toHaveLength(1)
    expect(console_!.requests.filter((r: any) => r.path === "/api/v1/me")).toHaveLength(1)
  })

  test("a gateway without the route, a refused key and a dead host leave the reading out", async () => {
    const source = await mocks({ gateway: { prices: false }, console: { anyKey: false } })
    const snapshot = await Account.snapshot({ source })
    expect(snapshot.prices).toBeUndefined()
    expect(snapshot.balance).toBeUndefined()
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
    const dead = `http://127.0.0.1:${probe.port}`
    await probe.stop(true)
    expect(await Account.snapshot({ source: { key: KEY, consoleURL: dead, gatewayURL: dead + "/v1" }, timeoutMs: 2000 })).toEqual({ at: expect.any(Number) })
  })

  test("a test run never calls a host that is not this machine", async () => {
    const real = globalThis.fetch
    let called = 0
    globalThis.fetch = (async () => {
      called++
      return new Response("{}")
    }) as unknown as typeof fetch
    try {
      const snapshot = await Account.snapshot({ source: { key: KEY, consoleURL: "https://console.rafikiai.io", gatewayURL: "https://gateway.rafikiai.io/v1" } })
      expect(snapshot.balance).toBeUndefined()
      expect(snapshot.prices).toBeUndefined()
      expect(called).toBe(0)
    } finally {
      globalThis.fetch = real
    }
  })

  test("parsing keeps the tier aliases, prefers the deployment's prices and drops unpriced tiers", () => {
    expect(
      Account.parsePrices({
        data: [
          { model_name: "rafiki-fast", litellm_params: { input_cost_per_token: 3e-7, output_cost_per_token: 1.2e-6 }, model_info: { input_cost_per_token: 9 } },
          // A second deployment of the same alias: the first one stands.
          { model_name: "rafiki-fast", litellm_params: { input_cost_per_token: 1, output_cost_per_token: 1 } },
          { model_name: "rafiki-pro", litellm_params: {}, model_info: { input_cost_per_token: 1.4e-6, output_cost_per_token: 4.4e-6, cache_read_input_token_cost: 2.6e-7 } },
          { model_name: "rafiki-max", litellm_params: { input_cost_per_token: 0, output_cost_per_token: 0 } },
          { model_name: "gpt-5", litellm_params: { input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 } },
          null,
        ],
      }),
    ).toEqual({
      fast: { input: 0.3, output: 1.2 },
      pro: { input: 1.4, output: 4.4, cacheRead: 0.26 },
    })
    expect(Account.parsePrices({ data: [] })).toBeUndefined()
    expect(Account.parsePrices({ error: "nope" })).toBeUndefined()
    expect(Account.parsePrices(undefined)).toBeUndefined()
    expect(Account.gatewayRoot("https://gateway.example/v1/")).toBe("https://gateway.example")
  })

  test("the mock's price list is the one the tests assume", () => {
    expect(MOCK_PRICES["rafiki-fast"].input_cost_per_token).toBe(0.000001)
  })
})

describe("the end of task line", () => {
  const tokens = { input: 4_000, output: 2_000, reasoning: 0, cache: { read: 6_000, write: 0 } }
  const prices: Cost.Prices = { fast: { input: 1, output: 2, cacheRead: 0.1 } }

  test("credits left count only what was spent since this run started", () => {
    const calls: Cost.Call[] = [
      { id: "old", root: true, turn: "u1", model: "rafiki-fast", tokens, time: 100 },
      { id: "new", root: true, turn: "u2", model: "rafiki-fast", tokens, time: 300 },
    ]
    // 0.0086 USD per call: both in the task's spend, only the second off the balance read at 200.
    expect(RafikiCost.line(calls, { balance: 1, prices, at: 200 }, 200)).toBe(
      "Task cost: tiers fast, fast · about 0.0172 USD (estimate) · caching saved about 0.0108 USD · about 0.9914 USD of credits left",
    )
  })

  test("the tracker reads the snapshot once and survives a failed reading", async () => {
    let taken = 0
    const tracker = RafikiCost.tracker({
      snapshot: async () => {
        taken++
        throw new Error("no network")
      },
    })
    const client = {
      session: {
        messages: async () => ({ data: [] }),
        children: async () => ({ data: [] }),
      },
    }
    await tracker.report(client as never, "ses_1")
    await tracker.report(client as never, "ses_1")
    expect(taken).toBe(1)
  })

  test("collect follows subagent sessions", async () => {
    const message = (id: string, sessionID: string) => ({
      info: { id, sessionID, role: "assistant", parentID: "u", modelID: "rafiki-fast", providerID: "rafiki", tokens, time: { created: 1 } },
      parts: [],
    })
    const client = {
      session: {
        messages: async ({ sessionID }: { sessionID: string }) => ({ data: [message("m_" + sessionID, sessionID)] }),
        children: async ({ sessionID }: { sessionID: string }) => ({
          data: sessionID === "root" ? [{ id: "child" }] : sessionID === "child" ? [{ id: "grandchild" }] : [],
        }),
      },
    }
    const calls = await RafikiCost.collect(client as never, "root")
    expect(calls.map((call) => [call.id, call.root])).toEqual([
      ["m_root", true],
      ["m_child", false],
      ["m_grandchild", false],
    ])
  })

  // A stream cut before its usage block leaves an ended message with no
  // token counts. The line counts it and says it is not in the amount.
  const none = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  const session = (list: { id: string; parentID: string; tokens: typeof tokens; completed?: number }[]) => ({
    session: {
      messages: async () => ({
        data: list.map((item, index) => ({
          info: {
            id: item.id,
            sessionID: "root",
            role: "assistant",
            parentID: item.parentID,
            modelID: "rafiki-fast",
            providerID: "rafiki",
            tokens: item.tokens,
            time: { created: 300 + index, completed: item.completed },
          },
          parts: [],
        })),
      }),
      children: async () => ({ data: [] }),
    },
  })

  test("a call without usage in the middle of a task is counted and named in the line", async () => {
    const client = session([
      { id: "a1", parentID: "u1", tokens, completed: 310 },
      { id: "a2", parentID: "u2", tokens: none, completed: 320 },
      { id: "a3", parentID: "u2", tokens, completed: 330 },
    ])
    const calls = await RafikiCost.collect(client as never, "root")
    expect(RafikiCost.line(calls, { balance: 1, prices, at: 200 }, 200)).toBe(
      "Task cost: tiers fast, fast · about 0.0172 USD (estimate) · 1 call reported no usage and is not included · caching saved about 0.0108 USD · at most about 0.9828 USD of credits left",
    )
  })

  test("a call without usage at the end of a task is counted and named in the line", async () => {
    const client = session([
      { id: "a1", parentID: "u1", tokens, completed: 310 },
      { id: "a2", parentID: "u2", tokens: none, completed: 320 },
    ])
    const calls = await RafikiCost.collect(client as never, "root")
    expect(RafikiCost.line(calls, { balance: 1, prices, at: 200 }, 200)).toBe(
      "Task cost: tiers fast, fast · about 0.0086 USD (estimate) · 1 call reported no usage and is not included · caching saved about 0.0054 USD · at most about 0.9914 USD of credits left",
    )
  })

  test("rafikicode run prints the line after the answer, from the gateway's usage and price list", async () => {
    const source = await mocks()
    const result = await spawnCli(home, ["run", "say hello"], {
      RAFIKICODE_API_KEY: KEY,
      RAFIKICODE_GATEWAY_URL: source.gatewayURL,
      RAFIKICODE_CONSOLE_URL: source.consoleURL,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Mock gateway reply")
    expect(result.stdout).not.toContain("Task cost")
    expect(result.stderr).toContain(
      "Task cost: tier fast · about 0.0086 USD (estimate) · caching saved about 0.0054 USD · about 12.39 USD of credits left",
    )
    // Read once for the task, not per request.
    expect(gateway!.requests.filter((r: any) => r.path === "/v1/model/info")).toHaveLength(1)
    expect(console_!.requests.filter((r: any) => r.path === "/api/v1/me")).toHaveLength(1)
  }, 60_000)

  test("without a price list the line gives token counts and no amount", async () => {
    const source = await mocks({ gateway: { prices: false } })
    const result = await spawnCli(home, ["run", "say hello"], {
      RAFIKICODE_API_KEY: KEY,
      RAFIKICODE_GATEWAY_URL: source.gatewayURL,
      RAFIKICODE_CONSOLE_URL: source.consoleURL,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("Task cost: tier fast · cost unknown, the gateway sent no price list (10,000 input and 2,000 output tokens)")
    expect(result.stderr).not.toContain("USD")
  }, 60_000)

  test("the JSON format prints no cost line", async () => {
    const source = await mocks()
    const result = await spawnCli(home, ["run", "--format", "json", "say hello"], {
      RAFIKICODE_API_KEY: KEY,
      RAFIKICODE_GATEWAY_URL: source.gatewayURL,
      RAFIKICODE_CONSOLE_URL: source.consoleURL,
    })
    expect(result.exitCode).toBe(0)
    expect(result.all).not.toContain("Task cost")
  }, 60_000)
})
