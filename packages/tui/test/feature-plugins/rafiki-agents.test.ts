import { expect, test } from "bun:test"
import fixture from "./fixtures/session-0.1.9.json"
import * as Agents from "../../src/feature-plugins/rafiki-agents"
import { createBuiltinPlugins } from "../../src/feature-plugins/builtins"

type Msg = { id: string; role: string; time: { created: number; completed?: number } }
function source(input: {
  messages: Record<string, Msg[]>
  parts: Record<string, unknown[]>
  todo?: Record<string, { status: string }[]>
  busy?: string[]
}): Agents.Source {
  return {
    messages: (id) => input.messages[id] ?? [],
    parts: (id) => (input.parts[id] ?? []) as never,
    todo: (id) => input.todo?.[id] ?? [],
    busy: (id) => input.busy?.includes(id) ?? false,
  }
}

const task = (status: string, extra: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) => ({
  type: "tool",
  tool: "task",
  callID: `call_${status}`,
  state: { status, input: { description: `Agent ${status}`, subagent_type: "explore" }, metadata, time: { start: 1_000 }, ...extra },
})

test("the agents section is registered and comes before the todo list", () => {
  const ids = createBuiltinPlugins({ experimentalEventSystem: false }).map((item) => item.id)
  expect(ids).toContain("internal:rafiki-agents")
  expect(ids).toContain("internal:rafiki-about")
})

test("lists the task runs with their state, and opens nothing without a child session", () => {
  const from = source({
    messages: { parent: [{ id: "m1", role: "assistant", time: { created: 1 } }] },
    parts: {
      m1: [
        task("running", {}, { sessionId: "child_run" }),
        task("completed", { time: { start: 1_000, end: 31_000 } }, { sessionId: "child_done" }),
        task("error", { time: { start: 1_000, end: 2_000 } }, { sessionId: "child_fail" }),
        task("error", {}, { sessionId: "child_stop", interrupted: true }),
        task("completed", {}, { sessionId: "child_bg", background: true }),
        { type: "tool", tool: "bash", state: { status: "running" } },
      ],
    },
    busy: ["child_bg"],
  })
  const list = Agents.list(from, "parent")
  expect(list.map((item) => item.status)).toEqual(["running", "done", "failed", "stopped", "running"])
  expect(list[1].title).toBe("Agent completed")
  expect(Agents.elapsed(list[1], 99_000)).toBe("30s")
  expect(Agents.active(from, "parent")?.sessionID).toBe("child_bg")
})

test("progress is the share of the subagent's todo list, never made up", () => {
  const agent: Agents.Agent = { callID: "c", sessionID: "child", title: "t", status: "running", start: 0 }
  const withTodo = source({
    messages: {},
    parts: {},
    todo: { child: [{ status: "completed" }, { status: "completed" }, { status: "in_progress" }, { status: "pending" }, { status: "cancelled" }] },
  })
  expect(Agents.progress(withTodo, agent)).toEqual({ kind: "todo", done: 2, total: 4, percent: 50 })
  expect(Agents.detail({ ...agent, agent: "explore" }, Agents.progress(withTodo, agent), 65_000)).toBe(
    "explore · running · 1m 5s · 50% (2/4)",
  )

  const steps = source({
    messages: {
      child: [
        { id: "a1", role: "assistant", time: { created: 1, completed: 2 } },
        { id: "a2", role: "assistant", time: { created: 3 } },
      ],
    },
    parts: { a2: [{ type: "tool", tool: "bash", state: { status: "running", title: "bun test" } }] },
  })
  const value = Agents.progress(steps, agent)
  expect(value).toEqual({ kind: "steps", steps: 2, current: "bash bun test" })
  expect(Agents.detail(agent, value, 5_000)).not.toContain("%")
  expect(Agents.progress(source({ messages: {}, parts: {} }), agent)).toBeUndefined()
})

test("a conversation stored by 0.1.9 loads: old task parts list, nothing throws", () => {
  const data = fixture as unknown as {
    session: { id: string }
    messages: Msg[]
    parts: Record<string, unknown[]>
    todo: Record<string, { status: string }[]>
  }
  const from = source({ messages: { [data.session.id]: data.messages }, parts: data.parts, todo: data.todo })
  const list = Agents.list(from, data.session.id)
  expect(list.map((item) => [item.title, item.status, item.sessionID])).toEqual([
    ["Read the auth code", "done", undefined],
    ["Fix the tests", "stopped", "ses_old_child"],
  ])
  expect(Agents.active(from, data.session.id)).toBeUndefined()
  expect(list.map((item) => Agents.detail(item, Agents.progress(from, item), Date.now()))).toEqual([
    "explore · done · 1m 0s",
    "general · stopped · 1m 38s",
  ])
})
