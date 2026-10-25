import { describe, expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Review from "../../src/rafiki/review"
import * as Verify from "../../src/rafiki/verify"

const user = (id: string, parts: unknown[]) => ({ info: { id, role: "user" }, parts }) as never
const assistant = (id: string, parts: unknown[]) => ({ info: { id, role: "assistant" }, parts }) as never

describe("the request", () => {
  test("short requests, questions and small edits are trivial", () => {
    expect(Review.trivial("Fix the value.")).toBe(true)
    expect(Review.trivial("Please fix the typo in the README heading of the install section")).toBe(true)
    expect(Review.trivial("How does the cache of the verify step decide when to read the project again?")).toBe(true)
    expect(
      Review.trivial(
        "Add a --text flag to flask.Config.from_file so a TOML file can be loaded in binary mode with tomllib.",
      ),
    ).toBe(false)
  })

  test("a bug report is recognised", () => {
    expect(Review.looksLikeBug("bell(n).limit(n, oo) should be oo, but it returns bell(oo)")).toBe(true)
    expect(Review.looksLikeBug("Matrix.hstack raises a TypeError on empty matrices")).toBe(true)
    expect(Review.looksLikeBug("Add a dark theme to the settings page with a toggle")).toBe(false)
  })

  test("only what the user wrote counts", () => {
    const message = user("u1", [
      { type: "text", text: "Add a flag." },
      { type: "text", text: "a note", synthetic: true },
      { type: "file", url: "x" },
    ])
    expect(Review.requestText(message)).toBe("Add a flag.")
  })
})

describe("criteria", () => {
  test("parsed from a fenced answer after reasoning, at most five", () => {
    const text = '<think>hm</think>\n```json\n{"bug": true, "criteria": ["a", " b ", "", "c", "d", "e", "f"]}\n```'
    const parsed = Review.parseCriteria(text, false)!
    expect(parsed.bug).toBe(true)
    expect(parsed.criteria).toEqual(["a", "b", "c", "d", "e"])
    // A bug fix keeps room for the reproduction criterion.
    const list = Review.withReproduction(parsed)
    expect(list.length).toBe(5)
    expect(list.at(-1)).toBe(Review.REPRODUCED)
  })

  test("an answer without criteria gives none", () => {
    expect(Review.parseCriteria("no idea", true)).toBeUndefined()
    expect(Review.parseCriteria('{"criteria": []}', true)).toBeUndefined()
    expect(Review.parseCriteria('{"criteria": ["x"]}', true)!.bug).toBe(true)
  })

  test("the note gives the reproduce first steps for a bug, with the test command", () => {
    const text = Review.note({ criteria: ["one", "two"], bug: true, testCommand: "python bin/test" })
    expect(text).toContain("check each one before you say the task is done")
    expect(Review.note({ criteria: ["one"], bug: false, reviewed: true })).toContain("a review checks each one")
    expect(text).toContain("1. one\n2. two")
    expect(text).toContain("Reproduce it before you fix it")
    expect(text).toContain("`python bin/test`")
    expect(text).toContain("Keep the test")
    expect(Review.note({ criteria: ["one"], bug: false })).not.toContain("Reproduce")
    expect(Review.note({ criteria: ["one"], bug: false })).toContain("Mark them completed in one update")
  })

  test("a todo list written by the model keeps the criteria", () => {
    const previous = [
      Review.todoOf("one"),
      Review.todoOf("two"),
      { content: "old step", status: "pending", priority: "low" },
    ]
    const next = [Review.todoOf("two"), { content: "new step", status: "in_progress", priority: "medium" }]
    expect(Review.keepCriteria(previous, next).map((todo) => todo.content)).toEqual([
      "Criterion: one",
      "Criterion: two",
      "new step",
    ])
  })

  test("a verdict ticks the criteria it met", () => {
    const todos = [Review.todoOf("one"), Review.todoOf("two"), { content: "step", status: "pending", priority: "low" }]
    const ticked = Review.tick(todos, ["one", "two"], {
      results: [
        { index: 0, pass: true, reason: "" },
        { index: 1, pass: false, reason: "" },
      ],
    })
    expect(ticked.map((todo) => todo.status)).toEqual(["completed", "pending", "pending"])
  })
})

describe("the review", () => {
  test("a verdict is read by criterion number, extra or repeated ids dropped", () => {
    const verdict = Review.parseVerdict(
      '{"results": [{"id": 2, "pass": false, "reason": "uses mode"}, {"id": 1, "pass": true}, {"id": 1, "pass": false}, {"id": 9, "pass": true}]}',
      2,
    )!
    expect(verdict.results).toEqual([
      { index: 0, pass: true, reason: "" },
      { index: 1, pass: false, reason: "uses mode" },
    ])
    expect(Review.parseVerdict("I think it is fine", 2)).toBeUndefined()
  })

  test("the prompt is curated: request, criteria, diff, checks and the last commands", () => {
    const commands = Array.from({ length: 3 }, (_, index) => ({
      command: `cmd ${index}`,
      exit: index,
      output: "x".repeat(2000),
    }))
    const prompt = Review.reviewPrompt({
      request: "Add a text flag",
      criteria: ["one", "two"],
      diff: "d".repeat(100_000),
      checks: [{ command: "pytest", status: "passed" }],
      commands,
      tests: ["tests/test_config.py"],
    })
    expect(prompt).toContain("## Request\nAdd a text flag")
    expect(prompt).toContain("1. one\n2. two")
    expect(prompt).toContain("$ pytest: passed")
    expect(prompt).toContain("Test files changed: tests/test_config.py")
    // Well under the gateway's input cap whatever the diff and the outputs.
    expect(prompt.length).toBeLessThan(40_000)
  })

  test("the commands of a turn come from its shell calls, the last twelve", () => {
    const parts = Array.from({ length: 15 }, (_, index) => ({
      type: "tool",
      tool: "bash",
      state: { status: "completed", input: { command: `echo ${index}` }, output: `${index}`, metadata: { exit: 0 } },
    }))
    const commands = Review.commandsOf([assistant("a1", parts)])
    expect(commands.length).toBe(12)
    expect(commands[0].command).toBe("echo 3")
  })

  test("the final line names what was not met and the cost", () => {
    const verdict = {
      results: [
        { index: 0, pass: true, reason: "" },
        { index: 1, pass: false, reason: "no" },
      ],
    }
    expect(Review.finalLine({ criteria: ["one", "two"], verdict, model: "rafiki-pro", cost: 0.0123, rounds: 1 })).toBe(
      "criteria not met: 2. two after 1 review round (review on rafiki-pro, 0.012 USD)",
    )
    expect(
      Review.finalLine({
        criteria: ["one"],
        verdict: { results: [{ index: 0, pass: true, reason: "" }] },
        model: "rafiki-pro",
        cost: 0,
        rounds: 0,
      }),
    ).toBe("criteria met: 1 of 1 (review on rafiki-pro, 0 USD)")
  })

  test("test files are recognised", () => {
    expect(Review.isTestFile("sympy/functions/combinatorial/tests/test_comb_numbers.py")).toBe(true)
    expect(Review.isTestFile("src/app.test.ts")).toBe(true)
    expect(Review.isTestFile("src/flask/config.py")).toBe(false)
  })
})

describe("settings", () => {
  test("the review is opt-in, the criteria are on, the env wins, one extra round at most", () => {
    expect(Review.enabled(undefined, {})).toBe(false)
    expect(Review.enabled(undefined, { [Brand.env.review]: "1" })).toBe(true)
    expect(Review.enabled({ enabled: true }, {})).toBe(true)
    expect(Review.criteriaEnabled(undefined)).toBe(true)
    expect(Review.criteriaEnabled({ criteria: false })).toBe(false)
    expect(Review.enabled({ enabled: true }, { [Brand.env.review]: "off" })).toBe(false)
    expect(Review.enabled({ enabled: false }, {})).toBe(false)
    expect(Review.rounds({ rounds: 4 })).toBe(1)
    expect(Review.rounds({ rounds: 0 })).toBe(0)
  })

  test("the models come from the routing: the review on rafiki-pro, the criteria on rafiki-fast", () => {
    const fast = { providerID: Brand.provider.id, modelID: "rafiki-fast" }
    const pro = { providerID: Brand.provider.id, modelID: "rafiki-pro" }
    const max = { providerID: Brand.provider.id, modelID: "rafiki-max" }
    // The review is a second opinion: rafiki-pro, pinned or not, unless the session is stronger.
    expect(Review.reviewModel(undefined, fast, { env: {} })).toMatchObject({
      ...pro,
      reason: "review: the review step",
    })
    expect(Review.reviewModel(undefined, fast, { pinned: true, env: {} }).modelID).toBe("rafiki-pro")
    expect(Review.reviewModel(undefined, max, { env: {} }).modelID).toBe("rafiki-max")
    // The criteria are cheap work: rafiki-fast unless the tier is pinned.
    expect(Review.criteriaModel(pro, { env: {} })).toMatchObject({
      ...fast,
      reason: "acceptance criteria: rafiki-fast",
    })
    expect(Review.criteriaModel(pro, { pinned: true, env: {} }).modelID).toBe("rafiki-pro")
    // RAFIKICODE_ROUTING=off keeps the session's tier for both.
    expect(Review.reviewModel(undefined, fast, { env: { [Brand.env.routing]: "off" } }).modelID).toBe("rafiki-fast")
    expect(Review.reviewModel({ model: "other/big" }, fast)).toMatchObject({ providerID: "other", modelID: "big" })
    expect(Review.reviewModel(undefined, { providerID: "other", modelID: "m" })).toMatchObject({
      providerID: "other",
      modelID: "m",
    })
  })
})

describe("the turn", () => {
  const criteria = {
    type: "text",
    text: "note",
    synthetic: true,
    metadata: { review: { kind: "criteria", criteria: ["one"], bug: false, cost: 0.002 } },
  }
  const reviewRound = {
    type: "text",
    text: "fix",
    synthetic: true,
    metadata: { review: { kind: "feedback", round: 1, rounds: 1, verdict: { results: [] }, cost: 0.01 } },
  }

  test("a review round continues the turn for the review and for the verify step", () => {
    const messages = [
      user("u1", [{ type: "text", text: "Add a flag to the config loader" }, criteria]),
      assistant("a1", [
        { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "/r/a.py" } } },
      ]),
      user("u2", [reviewRound]),
      assistant("a2", []),
    ]
    const turn = Review.turn(messages)
    expect(turn.start).toBe(messages[0])
    expect(turn.rounds).toBe(1)
    expect(turn.cost).toBeCloseTo(0.012)
    expect(Verify.turn(messages, "/r").files).toEqual(["/r/a.py"])
    expect(Verify.isRound((messages[2] as { parts: never[] }).parts)).toBe(true)
  })
})
