// Task cost accounting (src/brand/cost.ts): pricing by token class, the tier
// path, the cache saving, the estimate for the next turn, credits left, and
// the wording that keeps estimates apart from measured figures.
import { describe, expect, test } from "bun:test"
import * as Cost from "../../src/brand/cost"

// Round figures, USD per million tokens.
const prices: Cost.Prices = {
  fast: { input: 1, output: 2, cacheRead: 0.1 },
  pro: { input: 4, output: 8, cacheRead: 1 },
  max: { input: 10, output: 20, cacheRead: 1, cacheWrite: 12.5 },
}

const t = (input: number, output: number, read = 0, write = 0, reasoning = 0): Cost.Tokens => ({
  input,
  output,
  reasoning,
  cache: { read, write },
})

let clock = 0
const call = (model: string, turn: string | undefined, tokens: Cost.Tokens, root = true): Cost.Call => ({
  id: `msg_${++clock}`,
  root,
  turn,
  model,
  tokens,
  time: clock,
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

describe("price", () => {
  test("prices each token class at its own rate, reasoning as output", () => {
    const cost = Cost.price(t(1_000_000, 500_000, 2_000_000, 0, 500_000), prices.fast!)
    // 1M input at 1, 2M cache read at 0.1, 1M output and reasoning at 2.
    expect(cost.charged).toBeCloseTo(1 + 0.2 + 2, 10)
    // Uncached: all 3M input tokens at the full input price.
    expect(cost.uncached).toBeCloseTo(3 + 2, 10)
  })

  test("a cache write costs more than plain input where the tier lists a write price", () => {
    const cost = Cost.price(t(0, 0, 0, 1_000_000), prices.max!)
    expect(cost.charged).toBeCloseTo(12.5, 10)
    expect(cost.uncached).toBeCloseTo(10, 10)
  })

  test("a missing cache price falls back to the input price", () => {
    const cost = Cost.price(t(0, 0, 1_000_000, 1_000_000), { input: 3, output: 6 })
    expect(cost.charged).toBeCloseTo(6, 10)
    expect(cost.uncached).toBeCloseTo(6, 10)
  })
})

describe("summarize", () => {
  test("tier path, spend and cache saving over three turns and a subagent", () => {
    const calls = [
      call("rafiki-fast", "u1", t(100_000, 10_000)),
      call("rafiki-fast", "u1", t(20_000, 5_000, 100_000)),
      call("rafiki-fast", "u2", t(50_000, 10_000)),
      // A subagent call: counted in the spend, never in the path.
      call("rafiki-fast", undefined, t(200_000, 20_000), false),
      call("rafiki-pro", "u3", t(100_000, 10_000, 100_000)),
    ]
    const summary = Cost.summarize(calls, prices)
    expect(summary.path).toEqual(["fast", "fast", "pro"])
    expect(summary.tier).toBe("pro")
    expect(summary.priced).toBe(5)
    expect(summary.unpriced).toBe(0)
    // fast: 370k input, 45k output, 100k cache read. pro: 100k input, 10k output, 100k cache read.
    const fast = 0.37 * 1 + 0.045 * 2 + 0.1 * 0.1
    const pro = 0.1 * 4 + 0.01 * 8 + 0.1 * 1
    expect(summary.spent).toBeCloseTo(fast + pro, 10)
    // Saving: the cache reads at the full input price, minus what they cost.
    expect(summary.saved).toBeCloseTo(0.1 * (1 - 0.1) + 0.1 * (4 - 1), 10)
    expect(summary.tokens).toEqual(t(470_000, 55_000, 200_000))
  })

  test("a turn that changes tier half way lists both tiers", () => {
    const summary = Cost.summarize([call("rafiki-fast", "u1", t(10, 1)), call("rafiki-pro", "u1", t(10, 1))], prices)
    expect(summary.path).toEqual(["fast", "pro"])
  })

  test("a call with no usage still shows its tier and is not counted as free", () => {
    const summary = Cost.summarize([call("rafiki-pro", "u1", t(0, 0))], prices)
    expect(summary.path).toEqual(["pro"])
    expect(summary.priced).toBe(0)
    expect(summary.unpriced).toBe(0)
    expect(Cost.spentText(summary)).toBe("nothing spent yet")
  })

  test("without a price list nothing is priced and no amount is invented", () => {
    const summary = Cost.summarize([call("rafiki-fast", "u1", t(1200, 34))], undefined)
    expect(summary.spent).toBe(0)
    expect(summary.priced).toBe(0)
    expect(summary.unpriced).toBe(1)
    expect(Cost.spentText(summary)).toBe("cost unknown (1,234 tokens)")
    expect(Cost.savedText(summary)).toBeUndefined()
  })

  test("a tier the list has no price for and a model that is not a tier are reported as not priced", () => {
    const summary = Cost.summarize(
      [call("rafiki-fast", "u1", t(1_000_000, 0)), call("rafiki-max", "u2", t(1000, 10)), call("gpt-5", "u3", t(1000, 10))],
      { fast: prices.fast },
    )
    expect(summary.path).toEqual(["fast", "max"])
    expect(summary.spent).toBeCloseTo(1, 10)
    expect(summary.priced).toBe(1)
    expect(summary.unpriced).toBe(2)
    expect(Cost.spentText(summary)).toBe("about 1.00 USD spent (estimate, 2 calls not priced)")
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
    expect(Cost.callsOf(messages, true)).toEqual([{ id: "a1", root: true, turn: "u1", model: "rafiki-fast", tokens: t(10, 2), time: 2 }])
    expect(Cost.callsOf(messages, false)[0]!.turn).toBeUndefined()
  })
})

describe("nextTurn", () => {
  test("prices the last turn, its subagent calls included, on the other tier", () => {
    const calls = [
      call("rafiki-fast", "u1", t(500_000, 50_000)),
      call("rafiki-fast", "u2", t(100_000, 10_000)),
      call("rafiki-fast", undefined, t(100_000, 10_000), false),
      call("rafiki-fast", "u2", t(50_000, 5_000, 50_000)),
    ]
    // Last turn: 250k input, 25k output, 50k cache read, at pro prices.
    expect(Cost.nextTurn(calls, "pro", prices)).toBeCloseTo(0.25 * 4 + 0.025 * 8 + 0.05 * 1, 10)
  })

  test("is undefined before the first turn and without a price for the tier", () => {
    expect(Cost.nextTurn([], "pro", prices)).toBeUndefined()
    expect(Cost.nextTurn([call("rafiki-fast", "u1", t(10, 1))], "pro", { fast: prices.fast })).toBeUndefined()
  })
})

describe("display", () => {
  const calls = [call("rafiki-fast", "u1", t(1_000_000, 100_000)), call("rafiki-fast", "u2", t(1_000_000, 100_000))]

  test("credits left are the balance at the start minus what was spent since", () => {
    // 1.2 USD per call. The balance was read after the first call.
    const view = Cost.display({ calls, prices, start: { balance: 12.4, spent: 1.2 }, selected: "rafiki-fast" })
    expect(view.summary.spent).toBeCloseTo(2.4, 10)
    expect(view.left).toBeCloseTo(11.2, 10)
    expect(view.next).toBeUndefined()
    expect(Cost.statusLine(view)).toBe("fast · about 2.40 USD spent (estimate) · about 11.20 USD of credits left")
  })

  test("before a tier change the line leads with the new tier and its estimate", () => {
    const view = Cost.display({ calls, prices, start: { balance: 12.4, spent: 0 }, selected: "rafiki-pro" })
    expect(view.next).toEqual({ tier: "pro", estimate: 4.8 })
    expect(Cost.statusLine(view)).toBe(
      "next turn on pro: about 4.80 USD (estimate) · fast · about 2.40 USD spent (estimate) · about 10.00 USD of credits left",
    )
  })

  test("no balance reading, no credits figure", () => {
    const view = Cost.display({ calls, prices, selected: "rafiki-fast" })
    expect(view.left).toBeUndefined()
    expect(Cost.statusLine(view)).toBe("fast · about 2.40 USD spent (estimate)")
  })

  test("no price list: tokens are shown, the balance is the one read at the start, nothing is called an estimate", () => {
    const view = Cost.display({ calls, start: { balance: 12.4, spent: 0 }, selected: "rafiki-pro" })
    expect(Cost.statusLine(view)).toBe(
      "next turn on pro · fast · cost unknown (2,200,000 tokens) · 12.40 USD of credits when the task started",
    )
  })

  test("before the first answer the balance is shown as read", () => {
    const view = Cost.display({ calls: [call("rafiki-fast", "u1", t(0, 0))], prices, start: { balance: 12.4, spent: 0 } })
    expect(Cost.statusLine(view)).toBe("fast · nothing spent yet · 12.40 USD of credits")
  })
})

describe("the status line in a narrow terminal", () => {
  const calls = [call("rafiki-fast", "u1", t(1_000_000, 100_000))]
  const view = Cost.display({ calls, prices, start: { balance: 12.4, spent: 0 }, selected: "rafiki-fast" })
  const changing = Cost.display({ calls, prices, start: { balance: 12.4, spent: 0 }, selected: "rafiki-pro" })

  test("drops words first, then the credits, then everything but the tier", () => {
    expect(Cost.statusLine(view, 80)).toBe("fast · about 1.20 USD spent (estimate) · about 11.20 USD of credits left")
    expect(Cost.statusLine(view, 60)).toBe("fast · about 1.20 USD (estimate) · about 11.20 USD left")
    expect(Cost.statusLine(view, 40)).toBe("fast · about 1.20 USD (estimate)")
    expect(Cost.statusLine(view, 10)).toBe("fast")
    expect(Cost.statusLine(view, 3)).toBe("")
  })

  test("every form that shows an amount still calls it an estimate", () => {
    for (const room of [200, 120, 100, 80, 60, 50, 40]) {
      for (const text of [Cost.statusLine(view, room), Cost.statusLine(changing, room)]) {
        if (text.includes("USD")) expect(text).toContain("(estimate)")
      }
    }
  })

  test("before a tier change the new tier and its estimate are the last thing to go", () => {
    expect(Cost.statusLine(changing, 110)).toBe(
      "next turn on pro: about 4.80 USD (estimate) · fast · about 1.20 USD (estimate) · about 11.20 USD left",
    )
    expect(Cost.statusLine(changing, 80)).toBe("next turn on pro: about 4.80 USD (estimate) · fast · about 1.20 USD (estimate)")
    expect(Cost.statusLine(changing, 60)).toBe("next turn on pro: about 4.80 USD (estimate)")
    expect(Cost.statusLine(changing, 20)).toBe("")
  })
})

describe("the end of task line", () => {
  test("tier path, estimated spend, cache saving, credits left", () => {
    const calls = [
      call("rafiki-fast", "u1", t(100_000, 10_000)),
      call("rafiki-fast", "u2", t(100_000, 10_000, 1_000_000)),
      call("rafiki-pro", "u3", t(100_000, 10_000)),
    ]
    const view = Cost.display({ calls, prices, start: { balance: 12.4, spent: 0 } })
    expect(Cost.taskLine(view)).toBe(
      "Task cost: tiers fast, fast, pro · about 0.8200 USD (estimate) · caching saved about 0.9000 USD · about 11.58 USD of credits left",
    )
  })

  test("one tier, no caching", () => {
    const view = Cost.display({ calls: [call("rafiki-fast", "u1", t(12, 8))], prices })
    expect(Cost.taskLine(view)).toBe("Task cost: tier fast · under 0.0001 USD (estimate) · caching saved nothing")
  })

  test("a cache write that has not paid for itself yet is not called a saving", () => {
    const view = Cost.display({ calls: [call("rafiki-max", "u1", t(0, 10, 0, 100_000))], prices })
    expect(Cost.taskLine(view)).toContain("caching saved nothing yet")
  })

  test("without a price list the line says so and gives the token counts", () => {
    const view = Cost.display({ calls: [call("rafiki-fast", "u1", t(1200, 30, 34, 0, 4))], start: { balance: 5, spent: 0 } })
    expect(Cost.taskLine(view)).toBe("Task cost: tier fast · cost unknown, the gateway sent no price list (1,234 input and 34 output tokens)")
  })

  test("a task with no call on a Rafiki tier has no line", () => {
    expect(Cost.taskLine(Cost.display({ calls: [call("gpt-5", "u1", t(10, 1))], prices }))).toBeUndefined()
    expect(Cost.taskLine(Cost.display({ calls: [], prices }))).toBeUndefined()
  })

  test("the interface prints the remembered line under its exit lines", () => {
    Cost.remember("Task cost: tier fast")
    expect(Cost.epilogue()).toBe("  Task cost: tier fast\n\n")
    Cost.remember(undefined)
    expect(Cost.epilogue()).toBe("")
  })
})

describe("wording", () => {
  test("amounts keep enough digits for a single call and never show a rounded zero", () => {
    expect(Cost.usd(0.03123)).toBe("0.0312 USD")
    expect(Cost.usd(12.367)).toBe("12.37 USD")
    expect(Cost.usd(0)).toBe("0 USD")
    expect(Cost.usd(0.00001)).toBe("under 0.0001 USD")
    expect(Cost.usd(Number.NaN)).toBe("?")
  })

  test("a long path is folded into runs", () => {
    expect(Cost.pathText(["fast", "fast", "pro"])).toBe("fast, fast, pro")
    expect(Cost.pathText([...Array(12).fill("fast"), "pro", "pro", "pro", "fast"] as Cost.Tier[])).toBe("fast x12, pro x3, fast")
  })
})
