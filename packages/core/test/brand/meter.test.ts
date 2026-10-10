// The spend figures (src/brand/meter.ts): every one is a reading from the
// gateway or the Console, or a difference of two readings; a failed reading
// keeps the last figures and marks them stale; nothing is made up.
import { describe, expect, test } from "bun:test"
import * as Meter from "../../src/brand/meter"

const key = (spend: number, maxBudget: number | null = 25, at = 1_000) => ({ spend, maxBudget, at })

describe("readings", () => {
  test("the first good reading is the start, later ones move the last", () => {
    let state = Meter.update(Meter.empty(), { key: key(1.2), at: 1 })
    expect(state.start).toEqual(key(1.2))
    state = Meter.update(state, { key: key(1.2125), balance: 12.4, at: 2 })
    expect(state.start).toEqual(key(1.2))
    expect(state.last).toEqual(key(1.2125))
    expect(state.balance).toEqual({ usd: 12.4, at: 2 })
    expect(Meter.sessionSpend(state)).toBe(0.0125)
  })

  test("a failed reading keeps the last figures and marks them stale", () => {
    let state = Meter.update(Meter.empty(), { key: key(1), balance: 10, at: 1 })
    state = Meter.update(state, { failed: true, at: 2 })
    expect(state.stale).toBe(true)
    expect(state.last).toEqual(key(1))
    expect(state.balance).toEqual({ usd: 10, at: 1 })
    state = Meter.update(state, { key: key(1.5), at: 3 })
    expect(state.stale).toBe(false)
  })

  test("no reading, no figure", () => {
    expect(Meter.sessionSpend(Meter.empty())).toBeUndefined()
    expect(Meter.lines(Meter.empty())).toEqual([])
    expect(Meter.freshness(Meter.empty())).toBeUndefined()
    expect(Meter.freshness({ stale: true })).toBe("spend not available: the gateway did not answer")
  })

  test("a budget reset never shows a negative session spend", () => {
    expect(Meter.sessionSpend({ start: key(3), last: key(0.5), stale: false })).toBe(0)
  })
})

describe("budget share", () => {
  test("share of the key's budget, never rounded up", () => {
    expect(Meter.budgetShare(key(1.25, 25))).toBe("5%")
    expect(Meter.budgetShare(key(0.01, 25))).toBe("<1%")
    expect(Meter.budgetShare(key(0, 25))).toBe("0%")
    expect(Meter.budgetShare(key(24.99, 25))).toBe("99%")
    expect(Meter.budgetShare(key(25, 25))).toBe("100%")
    expect(Meter.budgetShare(key(3, null))).toBeUndefined()
    expect(Meter.budgetShare(undefined)).toBeUndefined()
  })

  test("the key line", () => {
    expect(Meter.keyText(key(1.25, 25))).toBe("1.25 of 25.00 USD (5%)")
    expect(Meter.keyText(key(0.0125, 2.5))).toBe("0.0125 of 2.50 USD (<1%)")
    expect(Meter.keyText(key(1.25, null))).toBe("1.25 USD, no budget cap")
  })
})

describe("texts", () => {
  const state: Meter.State = { start: key(1.2), last: key(1.2125, 25, new Date(2026, 9, 10, 12, 4, 31).getTime()), balance: { usd: 12.4, at: 1 }, stale: false }

  test("the sidebar lines and where they come from", () => {
    expect(Meter.lines(state)).toEqual([
      { label: "This session", value: "0.0125 USD" },
      { label: "Key", value: "1.21 of 25.00 USD (4%)" },
      { label: "Credits left", value: "12.40 USD" },
    ])
    expect(Meter.freshness(state)).toBe("from the gateway at 12:04:31")
    expect(Meter.freshness({ ...state, stale: true })).toBe("not updated since 12:04:31: the gateway did not answer")
  })

  test("the prompt row, shortened to the room it has", () => {
    expect(Meter.statusLine({ tier: "fast", state })).toBe("fast · 0.0125 USD this session · key budget 4% used")
    expect(Meter.statusLine({ tier: "fast", state }, 40)).toBe("fast · 0.0125 USD · 4% of budget")
    expect(Meter.statusLine({ tier: "fast", state }, 20)).toBe("fast · 0.0125 USD")
    expect(Meter.statusLine({ tier: "fast", state }, 10)).toBe("fast")
    expect(Meter.statusLine({ tier: "fast", state: { ...state, stale: true } })).toBe("fast · 0.0125 USD this session (stale) · key budget 4% used")
    expect(Meter.statusLine({ tier: "fast", next: "next turn on max (15x credits)", state })).toStartWith("next turn on max (15x credits) · fast · ")
    expect(Meter.statusLine({ tier: "fast", state: Meter.empty() })).toBe("fast · spend not read yet")
    expect(Meter.statusLine({ tier: "fast", state: { last: key(1, null), start: key(1, null), stale: false } })).toBe("fast · 0 USD this session · key 1.00 USD spent")
  })

  test("the run line", () => {
    expect(Meter.runLine({ path: "tier fast", requests: 2, sent: 49_060, received: 824, state })).toBe(
      "Task: tier fast · 2 requests, 49,060 tokens sent and 824 received in all · 0.0125 USD spent on this key during the task · key 1.21 of 25.00 USD (4%) · 12.40 USD of credits left",
    )
    expect(Meter.runLine({ path: "tier fast", requests: 1, sent: 10, received: 1, state: { stale: true } })).toBe(
      "Task: tier fast · 1 request, 10 tokens sent and 1 received in all · spend not available (the gateway did not answer)",
    )
    expect(Meter.runLine({ path: "tier fast", requests: 1, sent: 10, received: 1, state: { ...state, last: key(1.2) }, pending: true })).toContain(
      "0 USD counted on this key so far (the gateway had not counted the last requests yet)",
    )
  })

  test("amounts keep enough digits for a single request and never show a rounded zero", () => {
    expect(Meter.usd(0.03123)).toBe("0.0312 USD")
    expect(Meter.usd(12.367)).toBe("12.37 USD")
    expect(Meter.usd(0)).toBe("0 USD")
    expect(Meter.usd(0.00001)).toBe("under 0.0001 USD")
    expect(Meter.usd(Number.NaN)).toBe("?")
  })
})
