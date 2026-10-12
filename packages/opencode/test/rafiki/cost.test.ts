// The line rafikicode run prints after a task: requests and tokens as the
// gateway reported them, and what the key spent during the task by the
// gateway's own count (/key/info before and after), its budget, and the
// credits left from the Console. A real run against the mock gateway checks
// the figures printed are the ones the mock reported.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import * as Account from "@opencode-ai/core/brand/account"
import * as RafikiCost from "../../src/rafiki/cost"
import { createMockConsole } from "../brand/mock-console.mjs"
import { createMockGateway } from "../brand/mock-gateway.mjs"
import { spawnCli } from "./spawn"

const KEY = "sk-meter-run-0001"
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

async function mocks(options: { gateway?: Record<string, unknown>; console?: Record<string, unknown>; register?: boolean } = {}) {
  gateway = createMockGateway({ quiet: true, usage: USAGE, cost: 0.0025, ...options.gateway })
  console_ = createMockConsole({ quiet: true, anyKey: true, ...options.console })
  await Promise.all([gateway.ready, console_.ready])
  if (options.register !== false)
    await fetch(gateway.url + "/__test/register", {
      method: "POST",
      body: JSON.stringify({ key: KEY, key_alias: "rafikicode-meter-run", models: ["rafiki-fast", "rafiki-pro"], max_budget: 2.5 }),
    })
  return { RAFIKICODE_API_KEY: KEY, RAFIKICODE_GATEWAY_URL: gateway.url + "/v1", RAFIKICODE_CONSOLE_URL: console_.url }
}

const tokens = { input: 4_000, output: 2_000, reasoning: 0, cache: { read: 6_000, write: 0 } }
const step = { type: "step-finish", tokens }

function client(list: { id: string; parentID: string; steps: number; completed?: number }[], children: Record<string, string[]> = {}) {
  return {
    session: {
      messages: async ({ sessionID }: { sessionID: string }) => ({
        data: (sessionID === "root" ? list : [{ id: "c_" + sessionID, parentID: "cu", steps: 1, completed: 9 }]).map((item, index) => ({
          info: { id: item.id, sessionID, role: "assistant", parentID: item.parentID, modelID: "rafiki-fast", providerID: "rafiki", tokens, time: { created: 300 + index, completed: item.completed } },
          parts: Array.from({ length: item.steps }, () => step),
        })),
      }),
      children: async ({ sessionID }: { sessionID: string }) => ({ data: (children[sessionID] ?? []).map((id) => ({ id })) }),
    },
  }
}

const reply = (spend: number, maxBudget: number | null = 2.5): Account.KeyInfoResult => ({ ok: true, info: { spend, maxBudget, models: [] }, at: 0 })

describe("the line", () => {
  test("collect follows subagent sessions and counts every request (step), not every answer", async () => {
    const collected = await RafikiCost.collect(client([{ id: "a1", parentID: "u1", steps: 3, completed: 1 }], { root: ["child"], child: ["grandchild"] }) as never, "root")
    expect(collected.calls.map((call) => [call.id, call.root])).toEqual([
      ["a1", true],
      ["c_child", false],
      ["c_grandchild", false],
    ])
    expect(collected.steps).toHaveLength(5)
  })

  test("the spend is the key's spend after less before, read from the gateway", async () => {
    const replies = [reply(1.2), reply(1.2125)]
    const tracker = RafikiCost.tracker({ read: async () => replies.shift()!, balance: async () => 12.4 })
    const text = await tracker.text(client([{ id: "a1", parentID: "u1", steps: 2, completed: 1 }]) as never, "root")
    expect(text).toBe(
      "Task: tier fast · 2 requests, 20,000 tokens sent and 4,000 received in all · 0.0125 USD spent on this key during the task · key 1.21 of 2.50 USD (48%) · 12.40 USD of credits left",
    )
  })

  test("a gateway that has not counted the requests yet is read again, then the line says so", async () => {
    let reads = 0
    const tracker = RafikiCost.tracker({ read: async () => (reads++, reply(1)), balance: async () => undefined, retries: 2, retryMs: 1 })
    const text = await tracker.text(client([{ id: "a1", parentID: "u1", steps: 1, completed: 1 }]) as never, "root")
    expect(reads).toBe(4)
    expect(text).toContain("0 USD counted on this key so far (the gateway had not counted the last requests yet)")
  })

  test("no reading from the gateway, no amount", async () => {
    const tracker = RafikiCost.tracker({ read: async () => ({ ok: false, status: 401, at: 0 }), balance: async () => undefined })
    const text = await tracker.text(client([{ id: "a1", parentID: "u1", steps: 1, completed: 1 }]) as never, "root")
    expect(text).toBe("Task: tier fast · 1 request, 10,000 tokens sent and 2,000 received in all · spend not available (the gateway did not answer)")
    expect(text).not.toContain("about")
  })

  test("a failed reading after the task keeps the start and says nothing was added", async () => {
    const replies: Account.KeyInfoResult[] = [reply(1), { ok: false, at: 0 }]
    const tracker = RafikiCost.tracker({ read: async () => replies.shift()!, balance: async () => undefined })
    const text = await tracker.text(client([{ id: "a1", parentID: "u1", steps: 1, completed: 1 }]) as never, "root")
    expect(text).toContain("0 USD spent on this key during the task")
  })
})

describe("the wallet from the Console", () => {
  for (const [label, option, expected] of [
    ["not enforced", false, { usd: 12.4, enforced: false }],
    ["enforced", true, { usd: 12.4, enforced: true }],
    ["an older Console without the field", undefined, { usd: 12.4, enforced: undefined }],
  ] as const) {
    test(`${label}`, async () => {
      console_ = createMockConsole({ quiet: true, anyKey: true, billingEnforced: option })
      await console_.ready
      const source = { key: KEY, consoleURL: console_.url }
      expect(await Account.wallet(source)).toEqual(expected)
      expect(await Account.balance(source)).toBe(12.4)
    })
  }
})

describe("rafikicode run against the mock gateway", () => {
  test("prints the line after the answer with the figures the mock reported", async () => {
    const env = await mocks()
    const result = await spawnCli(home, ["run", "say hello"], env)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Mock gateway reply")
    expect(result.stdout).not.toContain("Task:")
    const keys = await (await fetch(gateway!.url + "/__test/keys")).json()
    const chats = gateway!.requests.filter((r: any) => r.path === "/v1/chat/completions" && r.status === 200).length
    expect(chats).toBeGreaterThan(0)
    // Every figure is the mock's: requests, its usage block, its spend, its budget, the console's balance.
    const spent = Math.round(chats * 0.0025 * 1e6) / 1e6
    expect(keys[0].spend).toBe(spent)
    // One request of the task (its usage block: 10,000 sent, 2,000 back); the
    // key's spend also counts the title request the run made, as the gateway does.
    expect(result.stderr).toContain(
      `Task: tier fast · 1 request, 10,000 tokens sent and 2,000 received in all · ${spent.toFixed(4)} USD spent on this key during the task · key ${spent.toFixed(4)} of 2.50 USD (<1%) · 12.40 USD of credits left`,
    )
    // The key is read before and after the task, not per request.
    expect(gateway!.requests.filter((r: any) => r.path === "/key/info").length).toBe(2)
    expect(result.stderr).not.toContain("estimate")
  }, 60_000)

  test("an account whose billing is not enforced: the line says so instead of the credits left", async () => {
    const env = await mocks({ console: { billingEnforced: false, balance: 11.01 } })
    const result = await spawnCli(home, ["run", "say hello"], env)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toMatch(/Task: tier fast · 1 request, .* · credits not enforced \(internal account\)/)
    expect(result.stderr).not.toContain("of credits left")
    expect(result.stderr).not.toContain("11.01")
  }, 60_000)

  test("a billed account keeps the credits left", async () => {
    const env = await mocks({ console: { billingEnforced: true, balance: 11.01 } })
    const result = await spawnCli(home, ["run", "say hello"], env)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain(" · 11.01 USD of credits left")
    expect(result.stderr).not.toContain("not enforced")
  }, 60_000)

  test("a key the gateway does not know gives no amount", async () => {
    const env = await mocks({ register: false })
    const result = await spawnCli(home, ["run", "say hello"], env)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("spend not available (the gateway did not answer)")
    expect(result.stderr).not.toContain("USD spent")
  }, 60_000)

  test("the JSON format prints no line", async () => {
    const env = await mocks()
    const result = await spawnCli(home, ["run", "--format", "json", "say hello"], env)
    expect(result.exitCode).toBe(0)
    expect(result.all).not.toContain("Task:")
  }, 60_000)
})

// The JSON events: each step_finish carries the usage of its request and a
// cost that is the gateway's figure or null, never 0; the task event comes
// last with the key's spend difference.
describe("rafikicode run --format json: usage and cost", () => {
  const events = (stdout: string) =>
    stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
  const usage = { input: 4_000, output: 2_000, reasoning: 0, cache_read: 6_000, cache_write: 0 }

  async function spentOnKey() {
    const keys = await (await fetch(gateway!.url + "/__test/keys")).json()
    return keys[0].spend as number
  }

  test("without a cost in the usage block: cost null, cost_source unknown, the task event has the key's spend", async () => {
    const env = await mocks()
    const result = await spawnCli(home, ["run", "--format", "json", "say hello"], env)
    expect(result.exitCode).toBe(0)
    const list = events(result.stdout)
    const steps = list.filter((event) => event.type === "step_finish")
    expect(steps).toHaveLength(1)
    for (const step of steps) {
      expect(step.usage).toEqual(usage)
      expect(step.cost).toBeNull()
      expect(step.cost_source).toBe("unknown")
      expect(step.part.cost).toBeNull()
      expect(step.part.tokens).toEqual(expect.objectContaining({ input: 4_000, output: 2_000 }))
    }
    expect(list.map((event) => event.type)).toEqual(["step_start", "text", "step_finish", "task"])
    const spent = await spentOnKey()
    expect(spent).toBeGreaterThan(0)
    expect(list.at(-1)).toEqual({
      type: "task",
      timestamp: expect.any(Number),
      sessionID: expect.any(String),
      tiers: ["fast"],
      requests: 1,
      usage,
      cost: spent,
      cost_source: "key_spend",
      pending: false,
      partial: null,
      key: { spend: spent, max_budget: 2.5 },
      credits: { usd: 12.4 },
    })
    expect(result.stdout).not.toContain('"cost":0,')
  }, 60_000)

  test("with the gateway's cost in the usage block: each step carries it", async () => {
    const env = await mocks({ gateway: { costInUsage: true } })
    const result = await spawnCli(home, ["run", "--format", "json", "say hello"], env)
    expect(result.exitCode).toBe(0)
    const list = events(result.stdout)
    const steps = list.filter((event) => event.type === "step_finish")
    expect(steps).toHaveLength(1)
    for (const step of steps) {
      expect(step.usage).toEqual(usage)
      expect(step.cost).toBe(0.0025)
      expect(step.cost_source).toBe("gateway")
      expect(step.part.cost).toBe(0.0025)
    }
    const task = list.at(-1)
    expect(task.type).toBe("task")
    expect(task.cost).toBe(await spentOnKey())
    expect(task.cost_source).toBe("key_spend")
  }, 60_000)
})

describe("the JSON fields", () => {
  test("a step without a figure is null and unknown, never 0", () => {
    expect(RafikiCost.stepCostFields({ cost: 0, providerID: "rafiki" })).toEqual({ cost: null, cost_source: "unknown" })
    expect(RafikiCost.stepCostFields({ cost: undefined, providerID: "openai" })).toEqual({ cost: null, cost_source: "unknown" })
    expect(RafikiCost.stepCostFields({ cost: 0.01, providerID: "rafiki" })).toEqual({ cost: 0.01, cost_source: "gateway" })
    expect(RafikiCost.stepCostFields({ cost: 0.01, providerID: "openai" })).toEqual({ cost: 0.01, cost_source: "price_list" })
  })

  test("the task event: no reading of the key is a null cost", async () => {
    const tracker = RafikiCost.tracker({ read: async () => ({ ok: false, status: 401, at: 0 }), balance: async () => undefined })
    const event = await tracker.event(client([{ id: "a1", parentID: "u1", steps: 2, completed: 1 }]) as never, "root")
    expect(event).toEqual(
      expect.objectContaining({ requests: 2, cost: null, cost_source: "unknown", key: null, credits: null }),
    )
    expect(event?.usage).toEqual({ input: 8_000, output: 4_000, reasoning: 0, cache_read: 12_000, cache_write: 0 })
  })
})
