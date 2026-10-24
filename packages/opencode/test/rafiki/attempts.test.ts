import { describe, expect, test } from "bun:test"
import * as Attempts from "../../src/rafiki/attempts"

const outcome = (over: Partial<Attempts.Outcome> & { index: number }): Attempts.Outcome => ({
  tier: "rafiki/rafiki-fast",
  approach: "smallest change",
  ended: "ok",
  checks: "passed",
  checksPassed: 2,
  checksRun: 2,
  diff: { files: 1, added: 4, removed: 1 },
  cost: 0.01,
  costSource: "gateway",
  seconds: 60,
  ...over,
})

describe("when attempts run", () => {
  test("the flag and the variable ask for them", () => {
    expect(Attempts.decide({ flag: 2, text: "fix it" })).toEqual({ count: 2, reason: "asked for with --attempts" })
    expect(Attempts.decide({ text: "fix it", env: { RAFIKICODE_ATTEMPTS: "3" } })?.count).toBe(3)
    expect(Attempts.decide({ text: "fix it", env: { RAFIKICODE_ATTEMPTS: "9" } })?.count).toBe(3)
    expect(Attempts.decide({ text: "fix it", env: {} })).toBeUndefined()
  })

  test("off wins over the flag and the automatic ones", () => {
    const env = { RAFIKICODE_ATTEMPTS: "off" }
    expect(Attempts.decide({ flag: 3, text: "x", env })).toBeUndefined()
    expect(Attempts.decide({ settings: { auto: true }, deep: true, text: "x", env })).toBeUndefined()
  })

  test("automatic only with attempts.auto, on the routing's difficulty signals", () => {
    const wide = "Refactor every module of the project to use the new logger"
    expect(Attempts.decide({ text: wide, env: {} })).toBeUndefined()
    expect(Attempts.decide({ settings: { auto: false }, deep: true, text: "x", env: {} })).toBeUndefined()
    expect(Attempts.decide({ settings: { auto: true }, text: "fix the typo", env: {} })).toBeUndefined()
    expect(Attempts.decide({ settings: { auto: true }, deep: true, text: "x", env: {} })).toEqual({
      count: 3,
      reason: "attempts.auto: a hard task (--deep)",
    })
    expect(Attempts.decide({ settings: { auto: true, count: 2 }, text: wide, env: {} })?.count).toBe(2)
  })

  test("the count is 2 or 3", () => {
    expect(Attempts.invalid(2)).toBeUndefined()
    expect(Attempts.invalid(3)).toBeUndefined()
    expect(Attempts.invalid(1)).toBeDefined()
    expect(Attempts.invalid(4)).toBeDefined()
    expect(Attempts.invalid(2.5)).toBeDefined()
  })

  test("/attempts N <task>", () => {
    expect(Attempts.parseCommand("3 fix the parser")).toEqual({ count: 3, task: "fix the parser" })
    expect(Attempts.parseCommand(" 2  fix\nthe parser ")).toEqual({ count: 2, task: "fix\nthe parser" })
    expect(Attempts.parseCommand('"3 fix the \\"parser\\""')).toEqual({ count: 3, task: 'fix the "parser"' })
    expect(Attempts.parseCommand("3")).toHaveProperty("error")
    expect(Attempts.parseCommand("fix the parser")).toHaveProperty("error")
    expect(Attempts.parseCommand("5 fix the parser")).toHaveProperty("error")
  })
})

describe("how attempts run", () => {
  test("rafiki-fast by default, the last one on Pro when asked, another model kept", () => {
    expect(Attempts.tiers({ count: 3 })).toEqual(["rafiki/rafiki-fast", "rafiki/rafiki-fast", "rafiki/rafiki-fast"])
    expect(Attempts.tiers({ count: 2, pro: true })).toEqual(["rafiki/rafiki-fast", "rafiki/rafiki-pro"])
    expect(Attempts.tiers({ count: 2, model: "rafiki/rafiki-pro" })).toEqual(["rafiki/rafiki-pro", "rafiki/rafiki-pro"])
    expect(Attempts.tiers({ count: 2, model: "rafiki/rafiki-pro", pro: true })).toEqual([
      "rafiki/rafiki-fast",
      "rafiki/rafiki-pro",
    ])
    expect(Attempts.tiers({ count: 2, model: "openai/gpt-x", pro: true })).toEqual(["openai/gpt-x", "openai/gpt-x"])
  })

  test("each attempt gets its own approach", () => {
    const prompts = [0, 1, 2].map((index) => Attempts.prompt("Fix the parser.", index, 3))
    expect(new Set(prompts).size).toBe(3)
    for (const [index, text] of prompts.entries()) {
      expect(text.startsWith("Fix the parser.\n")).toBe(true)
      expect(text).toContain(`Attempt ${index + 1} of 3`)
      expect(text).toContain(Attempts.APPROACHES[index]!.hint)
    }
  })

  test("the key's tokens per minute limit caps how many run at once", () => {
    expect(Attempts.concurrency(3, undefined)).toBe(3)
    expect(Attempts.concurrency(3, 2_000_000)).toBe(3)
    expect(Attempts.concurrency(3, 1_000_000)).toBe(2)
    expect(Attempts.concurrency(3, 200_000)).toBe(1)
    expect(Attempts.concurrency(2, 0)).toBe(2)
  })
})

describe("the attempt kept", () => {
  test("passed checks beat failing ones, whatever the size", () => {
    const picked = Attempts.pick([
      outcome({ index: 0, checks: "failing", checksPassed: 1, diff: { files: 1, added: 1, removed: 0 } }),
      outcome({ index: 1, diff: { files: 3, added: 40, removed: 9 } }),
    ])
    expect(picked?.winner.index).toBe(1)
    expect(picked?.reason).toContain("checks passed")
  })

  test("then the criteria the review found met", () => {
    const picked = Attempts.pick([
      outcome({ index: 0, criteria: { met: 2, total: 3 } }),
      outcome({ index: 1, criteria: { met: 3, total: 3 }, diff: { files: 2, added: 20, removed: 2 } }),
    ])
    expect(picked?.winner.index).toBe(1)
    expect(picked?.reason).toContain("more criteria met")
  })

  test("ties go to the smaller diff", () => {
    const picked = Attempts.pick([
      outcome({ index: 0, diff: { files: 1, added: 10, removed: 2 } }),
      outcome({ index: 1, diff: { files: 1, added: 3, removed: 1 } }),
      outcome({ index: 2, diff: { files: 1, added: 5, removed: 1 } }),
    ])
    expect(picked?.winner.index).toBe(1)
    expect(picked?.reason).toBe("the smaller diff of equal results")
  })

  test("an attempt that stopped or changed nothing is never kept", () => {
    expect(
      Attempts.pick([
        outcome({ index: 0, ended: "error", error: "timeout" }),
        outcome({ index: 1, diff: { files: 0, added: 0, removed: 0 } }),
      ]),
    ).toBeUndefined()
    const picked = Attempts.pick([
      outcome({ index: 0, ended: "error" }),
      outcome({ index: 1, checks: "failing", checksPassed: 0 }),
    ])
    expect(picked?.winner.index).toBe(1)
    expect(picked?.reason).toBe("the only attempt with a change")
  })
})

describe("what the person sees", () => {
  test("one line per attempt and the total", () => {
    const kept = outcome({ index: 1, criteria: { met: 3, total: 3 } })
    expect(Attempts.line(kept, true)).toBe(
      "attempt 2 (rafiki-fast, smallest change): checks passed (2 of 2), criteria 3 of 3, +4 -1 in 1 file, 0.010 USD, 60s  [kept]",
    )
    expect(Attempts.line(outcome({ index: 0, ended: "error", error: "exit code 1", costSource: "partial" }), false)).toContain(
      "stopped: exit code 1",
    )
    expect(Attempts.line(outcome({ index: 0, costSource: "partial" }), false)).toContain("about 0.010 USD")
    const summary: Attempts.Summary = {
      outcomes: [kept],
      winner: kept,
      reason: "the only attempt with a change",
      applied: true,
      total: 0.0312,
      totalSource: "key_spend",
    }
    expect(Attempts.totalLine(summary)).toBe(
      "attempts: kept attempt 2 (the only attempt with a change), applied to the working tree; total 0.031 USD",
    )
    expect(Attempts.totalLine({ ...summary, winner: undefined, applied: false, totalSource: "attempts" })).toContain(
      "nothing applied; total 0.031 USD (sum of the attempts)",
    )
    expect(Attempts.sessionNote("Fix it.", summary)).toContain("Do not redo the task")
  })
})

describe("the events of an attempt", () => {
  test("checks, criteria and cost are read from the JSON output", () => {
    const events = Attempts.readEvents([
      JSON.stringify({ type: "step_finish", cost: 0.002 }),
      JSON.stringify({ type: "step_finish", cost: null, cost_source: "unknown" }),
      JSON.stringify({ type: "verify", status: "retry", failed: ["pytest"] }),
      JSON.stringify({ type: "review", status: "retry", cost: 0.001 }),
      JSON.stringify({
        type: "review",
        status: "passed",
        cost: 0.004,
        criteria: [
          { text: "a", pass: true },
          { text: "b", pass: true },
        ],
      }),
      "not json",
      JSON.stringify({
        type: "verify",
        status: "passed",
        checks: [{ status: "passed" }, { status: "passed" }, { status: "skipped" }],
      }),
    ])
    expect(events.checks).toBe("passed")
    expect(events.checksRun).toBe(2)
    expect(events.checksPassed).toBe(2)
    expect(events.criteria).toEqual({ met: 2, total: 2 })
    expect(events.cost).toBeCloseTo(0.006)
    expect(events.unknownCost).toBe(true)
    expect(events.steps).toBe(2)
  })
})
