// The cost plugin's tracker: which model calls belong to the task on screen
// (its own, and those of subagent sessions seen on the event stream or found
// when the session is opened), the one reading of balance and price list per
// task, and the status line built from them.
import { describe, expect, test } from "bun:test"
import * as Cost from "@opencode-ai/core/brand/cost"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createBuiltinPlugins } from "../../src/feature-plugins/builtins"
import { createCostTracker, room } from "../../src/feature-plugins/rafiki-cost"
import { createTuiPluginApi } from "../fixture/tui-plugin"

const prices: Cost.Prices = { fast: { input: 1, output: 2, cacheRead: 0.1 }, pro: { input: 4, output: 8, cacheRead: 1 } }
const tokens = (input: number, output: number, read = 0) => ({ input, output, reasoning: 0, cache: { read, write: 0 } })

let clock = 0
const assistant = (id: string, parentID: string, modelID: string, t = tokens(1_000_000, 100_000)) => ({
  id,
  sessionID: "ses_root",
  role: "assistant" as const,
  parentID,
  modelID,
  providerID: "rafiki",
  tokens: t,
  time: { created: ++clock },
})

function harness(options: { children?: Record<string, { id: string }[]>; childMessages?: Record<string, unknown[]> } = {}) {
  const handlers = new Map<string, (event: any) => void>()
  const messages: unknown[] = []
  let snapshots = 0
  const api = createTuiPluginApi({
    event: { on: (type: string, handler: (event: any) => void) => (handlers.set(type, handler), () => {}) } as TuiPluginApi["event"],
    state: { session: { messages: () => messages as never } },
    client: {
      session: {
        children: async ({ sessionID }: { sessionID: string }) => ({ data: options.children?.[sessionID] ?? [] }),
        messages: async ({ sessionID }: { sessionID: string }) => ({ data: (options.childMessages?.[sessionID] ?? []).map((info) => ({ info, parts: [] })) }),
      },
    } as never,
  })
  const tracker = createCostTracker(api, {
    snapshot: async () => {
      snapshots++
      return { balance: 12.4, prices, at: 1 }
    },
  })
  return { tracker, messages, emit: (type: string, properties: unknown) => handlers.get(type)?.({ type, properties }), snapshots: () => snapshots }
}

describe("the cost plugin", () => {
  test("is one of the built in plugins", () => {
    expect(createBuiltinPlugins({ experimentalEventSystem: false }).map((plugin) => plugin.id)).toContain("internal:rafiki-cost")
  })

  test("the line gets the room the prompt row has left of the sidebar and the labels", () => {
    expect(room(170)).toBe(80)
    expect(room(121)).toBe(31)
    expect(room(120)).toBe(72)
    expect(room(80)).toBe(32)
  })

  test("before the readings arrive it shows the tier and tokens, no amount", () => {
    const { tracker, messages } = harness()
    messages.push(assistant("a1", "u1", "rafiki-fast"))
    expect(Cost.statusLine(tracker.display("ses_root", "rafiki-fast"))).toBe("fast · cost unknown (1,100,000 tokens)")
  })

  test("reads balance and price list once per task and follows the spend from the answers", async () => {
    const { tracker, messages, snapshots } = harness()
    messages.push(assistant("a1", "u1", "rafiki-fast"))
    await tracker.open("ses_root")
    await tracker.open("ses_root")
    expect(snapshots()).toBe(1)
    // 1.2 USD had been spent when the balance was read: nothing is taken off it yet.
    expect(Cost.statusLine(tracker.display("ses_root", "rafiki-fast"))).toBe(
      "fast · about 1.20 USD spent (estimate) · about 12.40 USD of credits left",
    )
    messages.push(assistant("a2", "u2", "rafiki-fast"))
    expect(Cost.statusLine(tracker.display("ses_root", "rafiki-fast"))).toBe(
      "fast · about 2.40 USD spent (estimate) · about 11.20 USD of credits left",
    )
    expect(snapshots()).toBe(1)
  })

  test("selecting another tier shows the new tier and its estimate before the turn is sent", async () => {
    const { tracker, messages } = harness()
    messages.push(assistant("a1", "u1", "rafiki-fast"))
    await tracker.open("ses_root")
    const view = tracker.display("ses_root", "rafiki-pro")
    expect(view.next).toEqual({ tier: "pro", estimate: 4.8 })
    expect(Cost.statusLine(view)).toStartWith("next turn on pro: about 4.80 USD (estimate) · fast · ")
    expect(Cost.taskLine(view)).toStartWith("Task cost: tier fast · about 1.20 USD (estimate)")
  })

  test("calls of a subagent session count toward the task, from the event stream", async () => {
    const { tracker, messages, emit } = harness()
    messages.push(assistant("a1", "u1", "rafiki-fast"))
    await tracker.open("ses_root")
    emit("session.created", { sessionID: "ses_child", info: { id: "ses_child", parentID: "ses_root" } })
    emit("message.updated", { sessionID: "ses_child", info: { ...assistant("c1", "cu1", "rafiki-fast", tokens(500_000, 0)), sessionID: "ses_child" } })
    // The same message again with its final usage: counted once.
    emit("message.updated", { sessionID: "ses_child", info: { ...assistant("c1", "cu1", "rafiki-fast", tokens(1_000_000, 0)), sessionID: "ses_child" } })
    // A session that is not under this task is ignored.
    emit("message.updated", { sessionID: "ses_other", info: { ...assistant("o1", "ou1", "rafiki-pro"), sessionID: "ses_other" } })
    const view = tracker.display("ses_root", "rafiki-fast")
    expect(view.summary.spent).toBeCloseTo(2.2, 10)
    expect(view.summary.path).toEqual(["fast"])
    expect(view.left).toBeCloseTo(11.4, 10)
  })

  test("subagent sessions that already exist are found when the session is opened", async () => {
    const { tracker, messages } = harness({
      children: { ses_root: [{ id: "ses_child" }], ses_child: [{ id: "ses_grandchild" }] },
      childMessages: {
        ses_child: [assistant("c1", "cu1", "rafiki-fast", tokens(1_000_000, 0))],
        ses_grandchild: [assistant("g1", "gu1", "rafiki-pro", tokens(1_000_000, 0))],
      },
    })
    messages.push(assistant("a1", "u1", "rafiki-fast"))
    await tracker.open("ses_root")
    const view = tracker.display("ses_root", "rafiki-fast")
    // 1.2 own, 1 on fast and 4 on pro in the subagents.
    expect(view.summary.spent).toBeCloseTo(6.2, 10)
    // All of it was spent before the balance was read.
    expect(view.left).toBeCloseTo(12.4, 10)
  })

  test("when a turn ends the subagent sessions are listed again, so a call the stream missed is counted", async () => {
    const children: Record<string, { id: string }[]> = {}
    const childMessages: Record<string, unknown[]> = {}
    const { tracker, messages, emit } = harness({ children, childMessages })
    messages.push(assistant("a1", "u1", "rafiki-fast"))
    await tracker.open("ses_root")
    children.ses_root = [{ id: "ses_child" }]
    childMessages.ses_child = [assistant("c1", "cu1", "rafiki-fast", tokens(1_000_000, 0))]
    emit("session.status", { sessionID: "ses_root", status: { type: "busy" } })
    expect(tracker.display("ses_root").summary.spent).toBeCloseTo(1.2, 10)
    emit("session.status", { sessionID: "ses_root", status: { type: "idle" } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(tracker.display("ses_root").summary.spent).toBeCloseTo(2.2, 10)
  })

  test("a call that ended without usage is named on the line, in the middle of a task and at its end", async () => {
    const { tracker, messages } = harness()
    const cut = (id: string, parentID: string) => ({ ...assistant(id, parentID, "rafiki-fast", tokens(0, 0)), time: { created: ++clock, completed: ++clock } })
    messages.push(assistant("a1", "u1", "rafiki-fast"), cut("a2", "u2"), assistant("a3", "u2", "rafiki-fast"))
    await tracker.open("ses_root")
    expect(Cost.statusLine(tracker.display("ses_root", "rafiki-fast"))).toBe(
      "fast · about 2.40 USD spent (estimate, 1 call reported no usage and is not included) · at most about 12.40 USD of credits left",
    )
    messages.push(cut("a4", "u3"))
    const view = tracker.display("ses_root", "rafiki-fast")
    expect(view.summary.unreported).toBe(2)
    expect(Cost.taskLine(view)).toBe(
      "Task cost: tiers fast, fast, fast · about 2.40 USD (estimate) · 2 calls reported no usage and are not included · caching saved nothing · at most about 12.40 USD of credits left",
    )
    // A call still running is not one of them.
    messages.push(assistant("a5", "u4", "rafiki-fast", tokens(0, 0)))
    expect(tracker.display("ses_root", "rafiki-fast").summary.unreported).toBe(2)
  })

  test("a failed reading leaves the line without amounts instead of failing", async () => {
    const api = createTuiPluginApi({
      event: { on: () => () => {} } as TuiPluginApi["event"],
      state: { session: { messages: () => [assistant("a1", "u1", "rafiki-fast")] as never } },
      client: { session: { children: async () => Promise.reject(new Error("down")), messages: async () => ({ data: [] }) } } as never,
    })
    const tracker = createCostTracker(api, { snapshot: async () => Promise.reject(new Error("down")) })
    await tracker.open("ses_root")
    expect(Cost.statusLine(tracker.display("ses_root"))).toBe("fast · cost unknown (1,100,000 tokens)")
  })
})
