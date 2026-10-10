// What a task did (src/brand/cost.ts): the tier of each turn and the tokens
// the gateway reported. No amount of money is worked out here.
import { describe, expect, test } from "bun:test"
import * as Cost from "../../src/brand/cost"

const t = (input: number, output: number, read = 0, write = 0, reasoning = 0): Cost.Tokens => ({
  input,
  output,
  reasoning,
  cache: { read, write },
})

let clock = 0
const call = (model: string, turn: string | undefined, tokens: Cost.Tokens, root = true, done = true): Cost.Call => ({
  id: `msg_${++clock}`,
  root,
  turn,
  model,
  tokens,
  time: clock,
  done,
})

describe("tierOf", () => {
  test("names the tier of a gateway alias and nothing else", () => {
    expect(Cost.tierOf("rafiki-fast")).toBe("fast")
    expect(Cost.tierOf("rafiki-pro")).toBe("pro")
    expect(Cost.tierOf("rafiki-max")).toBe("max")
    expect(Cost.tierOf("rafiki-fast-b")).toBeUndefined()
    expect(Cost.tierOf("gpt-5")).toBeUndefined()
    expect(Cost.tierOf(undefined)).toBeUndefined()
  })
})

describe("summarize", () => {
  test("tier path over turns, subagent calls in the tokens but not in the path", () => {
    const summary = Cost.summarize([
      call("rafiki-fast", "u1", t(100, 10, 50)),
      call("rafiki-fast", "u2", t(200, 20)),
      call("rafiki-pro", undefined, t(5, 5), false),
      call("rafiki-pro", "u3", t(300, 30, 0, 8)),
    ])
    expect(summary.path).toEqual(["fast", "fast", "pro"])
    expect(summary.tier).toBe("pro")
    expect(summary.tokens).toEqual(t(605, 65, 50, 8))
    expect(summary.reported).toBe(4)
    expect(summary.unreported).toBe(0)
  })

  test("a turn that changes tier half way lists both tiers", () => {
    expect(Cost.summarize([call("rafiki-fast", "u1", t(1, 1)), call("rafiki-pro", "u1", t(1, 1))]).path).toEqual(["fast", "pro"])
  })

  test("a call that ended without usage is counted apart; one still running is not", () => {
    const summary = Cost.summarize([call("rafiki-fast", "u1", t(0, 0)), call("rafiki-fast", "u2", t(0, 0), true, false)])
    expect(summary.path).toEqual(["fast", "fast"])
    expect(summary.unreported).toBe(1)
    expect(summary.reported).toBe(0)
  })

  test("garbage token counts are read as zero", () => {
    expect(Cost.tokens({ input: -5, output: Number.NaN, cache: { read: Infinity, write: 3 } } as never)).toEqual(t(0, 0, 0, 3))
    expect(Cost.tokens(undefined)).toEqual(t(0, 0))
  })
})

describe("callsOf", () => {
  test("keeps assistant messages, with the request they answer for the task's own session", () => {
    const messages = [
      { id: "u1", role: "user", time: { created: 1 } },
      { id: "a1", role: "assistant", parentID: "u1", modelID: "rafiki-fast", tokens: t(10, 2), time: { created: 2 } },
    ]
    expect(Cost.callsOf(messages, true)).toEqual([{ id: "a1", root: true, turn: "u1", model: "rafiki-fast", tokens: t(10, 2), time: 2, done: false }])
    expect(Cost.callsOf(messages, false)[0]!.turn).toBeUndefined()
  })
})

describe("wording", () => {
  test("a long path is folded into runs", () => {
    expect(Cost.pathText(["fast", "fast", "pro"])).toBe("fast, fast, pro")
    expect(Cost.pathText([...Array(12).fill("fast"), "pro", "pro", "pro", "fast"] as Cost.Tier[])).toBe("fast x12, pro x3, fast")
  })

  test("the interface prints the remembered line under its exit lines", () => {
    Cost.remember("Last session: fast")
    expect(Cost.epilogue()).toBe("  Last session: fast\n\n")
    Cost.remember(undefined)
    expect(Cost.epilogue()).toBe("")
  })
})
