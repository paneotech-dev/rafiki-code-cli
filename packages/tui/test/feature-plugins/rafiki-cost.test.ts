// The spend plugin's tracker: readings of the key from the gateway after each
// completed answer (debounced, never per chunk), the start of each session,
// stale figures after a failed reading, and the lines built from them. One
// test reads a mock gateway over HTTP and checks the figures shown are the
// ones it reported.
import { afterEach, describe, expect, test } from "bun:test"
import * as Account from "@opencode-ai/core/brand/account"
import * as Meter from "@opencode-ai/core/brand/meter"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createBuiltinPlugins } from "../../src/feature-plugins/builtins"
import { createMeterTracker, room, statusLine, view } from "../../src/feature-plugins/rafiki-cost"
import { createTuiPluginApi } from "../fixture/tui-plugin"
import { createMockGateway } from "../../../opencode/test/brand/mock-gateway.mjs"

const tokens = (input: number, output: number, read = 0) => ({ input, output, reasoning: 0, cache: { read, write: 0 } })
let clock = 0
const assistant = (id: string, parentID: string, modelID: string, t = tokens(1_000, 100)) => ({
  id,
  sessionID: "ses_root",
  role: "assistant" as const,
  parentID,
  modelID,
  providerID: "rafiki",
  tokens: t,
  time: { created: ++clock, completed: clock },
})

const trackers: { dispose(): void }[] = []
afterEach(() => {
  for (const tracker of trackers.splice(0)) tracker.dispose()
})

function harness(input: { replies: (Account.KeyInfoResult | Error)[]; balance?: number; now?: () => number }) {
  const handlers = new Map<string, (event: any) => void>()
  const messages: unknown[] = []
  let reads = 0
  const api = createTuiPluginApi({
    event: { on: (type: string, handler: (event: any) => void) => (handlers.set(type, handler), () => {}) } as TuiPluginApi["event"],
    state: { session: { messages: () => messages as never } },
  })
  const tracker = createMeterTracker(api, {
    read: async () => {
      const reply = input.replies[Math.min(reads++, input.replies.length - 1)]!
      if (reply instanceof Error) throw reply
      return reply
    },
    balance: async () => input.balance,
    now: input.now,
    debounceMs: 5,
    followUpMs: 40,
  })
  trackers.push(tracker)
  return { tracker, messages, reads: () => reads, emit: (type: string, properties: unknown) => handlers.get(type)?.({ type, properties }) }
}

const info = (spend: number, maxBudget: number | null = 25): Account.KeyInfoResult => ({ ok: true, info: { spend, maxBudget, models: [] }, at: 0 })
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("the spend plugin", () => {
  test("is one of the built in plugins", () => {
    expect(createBuiltinPlugins({ experimentalEventSystem: false }).map((plugin) => plugin.id)).toContain("internal:rafiki-cost")
  })

  test("the line gets the room the prompt row has left of the sidebar and the labels", () => {
    expect(room(170)).toBe(80)
    expect(room(121)).toBe(31)
    expect(room(120)).toBe(72)
    expect(room(80)).toBe(32)
  })

  test("before any reading it shows the tier and says spend is not read, no amount", () => {
    const { tracker, messages } = harness({ replies: [info(1)] })
    messages.push(assistant("a1", "u1", "rafiki-fast"))
    expect(statusLine(view(tracker, "ses_root", "rafiki-fast"))).toBe("fast · spend not read yet")
  })

  test("this session is the key's spend less its spend when the session opened, read again after an answer", async () => {
    const { tracker, messages, emit, reads } = harness({ replies: [info(1.2), info(1.2125)], balance: 12.4 })
    messages.push(assistant("a1", "u1", "rafiki-fast"))
    await tracker.open("ses_root")
    expect(Meter.sessionSpend(tracker.state("ses_root"))).toBe(0)
    // Streamed chunks do not read; a completed answer does, once, after the debounce.
    emit("message.part.updated", {})
    emit("message.updated", { sessionID: "ses_root", info: { role: "assistant", time: { created: 1 } } })
    expect(reads()).toBe(1)
    emit("message.updated", { sessionID: "ses_root", info: { role: "assistant", time: { created: 1, completed: 2 } } })
    emit("session.status", { sessionID: "ses_root", status: { type: "idle" } })
    await wait(25)
    expect(reads()).toBe(2)
    const value = view(tracker, "ses_root", "rafiki-fast")
    expect(statusLine(value)).toBe("fast · 0.0125 USD this session · key budget 4% used")
    expect(Meter.lines(value.state)).toEqual([
      { label: "This session", value: "0.0125 USD" },
      { label: "Key", value: "1.21 of 25.00 USD (4%)" },
      { label: "Credits left", value: "12.40 USD" },
    ])
    // The follow up reading for a request the gateway counts late.
    await wait(40)
    expect(reads()).toBe(3)
  })

  test("a session created after the interface started counts from the reading before it was created", async () => {
    let time = 100
    const { tracker } = harness({ replies: [info(2), info(2.5)], now: () => time })
    await tracker.refresh()
    time = 200
    // Created at 150: the first request was already charged when the session came on screen.
    await tracker.open("ses_root", 150)
    expect(Meter.sessionSpend(tracker.state("ses_root"))).toBe(0.5)
  })

  test("a failed reading keeps the last figures and marks them stale", async () => {
    const { tracker, messages } = harness({ replies: [info(1), info(1.5), new Error("down")] })
    messages.push(assistant("a1", "u1", "rafiki-fast"))
    await tracker.open("ses_root")
    await tracker.refresh()
    await tracker.refresh()
    const state = tracker.state("ses_root")
    expect(state.stale).toBe(true)
    expect(Meter.sessionSpend(state)).toBe(0.5)
    expect(statusLine(view(tracker, "ses_root", "rafiki-fast"))).toBe("fast · 0.5000 USD this session (stale) · key budget 6% used")
    expect(Meter.freshness(state)).toStartWith("not updated since ")
  })

  test("a gateway that never answered shows no amount at all", async () => {
    const { tracker, messages } = harness({ replies: [{ ok: false, at: 0 }] })
    messages.push(assistant("a1", "u1", "rafiki-fast"))
    await tracker.open("ses_root")
    expect(statusLine(view(tracker, "ses_root", "rafiki-fast"))).toBe("fast · spend not available")
    expect(Meter.lines(tracker.state("ses_root"))).toEqual([])
  })

  test("picking another tier names it with its credit rate, no estimate", async () => {
    const { tracker, messages } = harness({ replies: [info(1)] })
    messages.push(assistant("a1", "u1", "rafiki-fast"))
    await tracker.open("ses_root")
    expect(view(tracker, "ses_root", "rafiki-max").next).toBe("next turn on max (15x credits)")
    expect(view(tracker, "ses_root", "rafiki-fast").next).toBeUndefined()
  })
})

describe("against the mock gateway", () => {
  test("the figures shown are the ones the gateway reported for the key", async () => {
    const gateway = createMockGateway({ quiet: true, cost: 0.0025 })
    await gateway.ready
    try {
      await fetch(gateway.url + "/__test/register", {
        method: "POST",
        body: JSON.stringify({ key: "sk-meter-0001", key_alias: "rafikicode-meter", models: ["rafiki-fast"], max_budget: 2.5 }),
      })
      const source = { key: "sk-meter-0001", gatewayURL: gateway.url + "/v1" }
      const handlers = new Map<string, (event: any) => void>()
      const api = createTuiPluginApi({
        event: { on: (type: string, handler: (event: any) => void) => (handlers.set(type, handler), () => {}) } as TuiPluginApi["event"],
        state: { session: { messages: () => [assistant("a1", "u1", "rafiki-fast")] as never } },
      })
      const tracker = createMeterTracker(api, { read: () => Account.keyInfo({ source }), balance: async () => undefined, debounceMs: 5, followUpMs: 10_000 })
      trackers.push(tracker)
      await tracker.open("ses_root")
      for (let i = 0; i < 3; i++) {
        const response = await fetch(gateway.url + "/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer sk-meter-0001" },
          body: JSON.stringify({ model: "rafiki-fast", messages: [{ role: "user", content: "hi" }] }),
        })
        expect(response.status).toBe(200)
      }
      handlers.get("session.status")?.({ properties: { sessionID: "ses_root", status: { type: "idle" } } })
      await wait(100)
      const reported = (await (await fetch(gateway.url + "/__test/keys")).json())[0]
      const state = tracker.state("ses_root")
      expect(state.last?.spend).toBe(reported.spend)
      expect(state.last?.maxBudget).toBe(reported.max_budget)
      expect(Meter.sessionSpend(state)).toBe(0.0075)
      expect(statusLine(view(tracker, "ses_root", "rafiki-fast"))).toBe("fast · 0.0075 USD this session · key budget <1% used")
      expect(Meter.lines(state)).toEqual([
        { label: "This session", value: "0.0075 USD" },
        { label: "Key", value: "0.0075 of 2.50 USD (<1%)" },
      ])
    } finally {
      await gateway.close()
    }
  })
})
