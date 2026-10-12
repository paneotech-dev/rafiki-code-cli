import { expect, test } from "bun:test"
import * as Steer from "@opencode-ai/core/brand/steer"

test("the mark sits on a text part and only there", () => {
  expect(Steer.marked({ type: "text", text: "x", metadata: Steer.metadata() })).toBe(true)
  expect(Steer.marked({ type: "text", text: "x", metadata: { other: 1 } })).toBe(false)
  expect(Steer.marked({ type: "file", metadata: Steer.metadata() })).toBe(false)
  expect(Steer.marked(undefined)).toBe(false)
  expect(Steer.metadata({ kind: "a" })).toEqual({ kind: "a", [Steer.KEY]: true })
})

test("queued: the user messages after the answer in progress", () => {
  const m = (id: string, role: string, completed?: number) => ({ id, role, time: { created: 1, completed } })
  expect(Steer.queued([m("u1", "user"), m("a1", "assistant", 2)])).toEqual([])
  expect(Steer.queued([m("u1", "user"), m("a1", "assistant"), m("u2", "user"), m("u3", "user")]).map((x) => x.id)).toEqual(["u2", "u3"])
  expect(Steer.hint("ctrl+x return")).toContain("ctrl+x return")
})
