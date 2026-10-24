// Stuck detection (rafiki/stuck.ts, rafiki/stuck-turn.ts): the same failure
// three times, or edits that undo each other, give the turn one note, one line
// for the user, and the "stuck" routing signal.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Stuck from "../../src/rafiki/stuck"
import * as StuckTurn from "../../src/rafiki/stuck-turn"
import * as Routing from "../../src/rafiki/routing"
import * as Verify from "../../src/rafiki/verify"

const user = (id: string, meta?: Record<string, unknown>) => ({
  info: { id, role: "user", sessionID: "s", agent: "build", model: { providerID: "rafiki", modelID: "rafiki-fast" }, time: { created: 1 } },
  parts: [{ type: "text", text: "x", ...(meta ? { synthetic: true, metadata: meta } : {}) }],
})
const assistant = (id: string, parentID: string, parts: unknown[]) => ({
  info: { id, role: "assistant", parentID, sessionID: "s", time: { created: 2 } },
  parts,
})
const bash = (command: string, exit: number, output: string) => ({
  type: "tool",
  tool: "bash",
  state: { status: "completed", input: { command }, output, metadata: { exit } },
})
const failedEdit = (filePath: string, oldString: string) => ({
  type: "tool",
  tool: "edit",
  state: { status: "error", input: { filePath, oldString, newString: "y" }, error: "Could not find oldString in the file." },
})
const edit = (filePath: string, oldString: string, newString: string) => ({
  type: "tool",
  tool: "edit",
  state: { status: "completed", input: { filePath, oldString, newString }, output: "ok", metadata: {} },
})

describe("scan", () => {
  test("the same command with the same error three times is stuck, twice is not", () => {
    const run = (n: number) =>
      [
        user("u1"),
        ...Array.from({ length: n }, (_, i) =>
          assistant(`a${i}`, "u1", [bash("npm test", 1, `FAIL src/a.test.ts\nTests: 1 failed\nTime: ${i + 1}.2 s`)]),
        ),
      ] as never
    expect(Stuck.scan(run(2))).toBeUndefined()
    const found = Stuck.scan(run(3))
    expect(found?.reason).toBe("repeat")
    expect(found?.subject).toBe("npm test")
    expect(found?.count).toBe(3)
    expect(found?.error).toContain("FAIL src/a.test.ts")
  })

  test("a different error each time is not stuck", () => {
    const messages = [
      user("u1"),
      assistant("a1", "u1", [bash("pytest", 1, "E assert 1 == 2"), bash("pytest", 1, "E assert 3 == 4"), bash("pytest", 1, "E NameError: x")]),
    ] as never
    expect(Stuck.scan(messages)).toBeUndefined()
  })

  test("a command that passes in between still counts its failures; exit 0 is never a failure", () => {
    const messages = [
      user("u1"),
      assistant("a1", "u1", [bash("make", 2, "boom"), bash("ls", 0, ""), bash("make", 2, "boom"), bash("ls", 0, ""), bash("make", 2, "boom")]),
    ] as never
    expect(Stuck.scan(messages)?.subject).toBe("make")
  })

  test("an edit that fails on the same file the same way three times is stuck, whatever text it was given", () => {
    const messages = [user("u1"), assistant("a1", "u1", [failedEdit("/p/a.ts", "one"), failedEdit("/p/a.ts", "two"), failedEdit("/p/a.ts", "three")])] as never
    expect(Stuck.scan(messages)?.subject).toBe("edit /p/a.ts")
  })

  test("edits that keep undoing each other are stuck after two reverts", () => {
    const once = [user("u1"), assistant("a1", "u1", [edit("/p/a.ts", "A", "B"), edit("/p/a.ts", "B", "A")])] as never
    expect(Stuck.scan(once)).toBeUndefined()
    const twice = [user("u1"), assistant("a1", "u1", [edit("/p/a.ts", "A", "B"), edit("/p/a.ts", "B", "A"), edit("/p/a.ts", "A", "B")])] as never
    const found = Stuck.scan(twice)
    expect(found?.reason).toBe("revert")
    expect(found?.subject).toBe("/p/a.ts")
  })

  test("writes back to an earlier content count as reverts", () => {
    const write = (content: string) => ({ type: "tool", tool: "write", state: { status: "completed", input: { filePath: "/p/b.py", content }, output: "", metadata: {} } })
    const messages = [user("u1"), assistant("a1", "u1", [write("1"), write("2"), write("1"), write("2")])] as never
    expect(Stuck.scan(messages)?.reason).toBe("revert")
  })

  test("only the current turn counts, a noted pattern is not noted again, and a turn gets two notes at most", () => {
    const fails = (id: string, parent: string, command: string) => assistant(id, parent, [bash(command, 1, "x"), bash(command, 1, "x"), bash(command, 1, "x")])
    const older = [user("u0"), fails("a0", "u0", "make"), user("u1"), assistant("a1", "u1", [])] as never
    expect(Stuck.scan(older)).toBeUndefined()

    const first = Stuck.scan([user("u1"), fails("a1", "u1", "make")] as never)!
    const noted = [user("u1"), fails("a1", "u1", "make"), user("n1", { stuck: { ...first, kind: "stuck" } })]
    expect(Stuck.scan(noted as never)).toBeUndefined()
    expect(Stuck.noted(noted as never)).toBe(true)

    const second = Stuck.scan([...noted, fails("a2", "n1", "tsc")] as never)!
    expect(second.subject).toBe("tsc")
    const full = [...noted, fails("a2", "n1", "tsc"), user("n2", { stuck: { ...second, kind: "stuck" } }), fails("a3", "n2", "go test")]
    expect(Stuck.scan(full as never)).toBeUndefined()
  })

  test("timings and temporary paths do not make the same failure look different", () => {
    expect(Stuck.normalize("took 1.23s in /tmp/abc123/x pid=42")).toBe(Stuck.normalize("took 9.9s in /tmp/zzz/y pid=7"))
  })

  test("a stuck note is not a new turn for the verify step", () => {
    const messages = [
      user("u1"),
      assistant("a1", "u1", [{ type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "a.py" } } }]),
      user("n1", { stuck: { kind: "stuck", reason: "repeat", subject: "x", key: "k", count: 3 } }),
      assistant("a2", "n1", []),
    ] as never
    expect(Verify.turn(messages, "/p").files).toEqual(["/p/a.py"])
  })
})

describe("routing", () => {
  test("a stuck turn on rafiki-fast goes to rafiki-pro; pinned, pro and max turns stay", () => {
    expect(Routing.signalOf({ sessionID: "x", agent: "build", text: "fix it", failures: [], stuck: true })).toBe("stuck")
    const choose = (tier: string, pinned = false) =>
      Routing.choose({ purpose: "turn", providerID: "rafiki", tier, pinned, signal: "stuck", env: {} })
    expect(choose("rafiki-fast")).toMatchObject({ tier: "rafiki-pro", escalated: true })
    expect(choose("rafiki-fast", true)).toMatchObject({ tier: "rafiki-fast", escalated: false })
    expect(choose("rafiki-pro")).toMatchObject({ tier: "rafiki-pro", escalated: false })
    expect(choose("rafiki-max")).toMatchObject({ tier: "rafiki-max", escalated: false })
  })

  test("a failing check twice in a row stays the failing signal", () => {
    expect(Routing.signalOf({ sessionID: "x", agent: "build", text: "", failures: [["npm test"], ["npm test"]], stuck: true })).toBe("failing")
  })
})

describe("the note", () => {
  const fake = () => {
    const messages: any[] = []
    const parts: any[] = []
    return {
      messages,
      parts,
      sessions: {
        updateMessage: (msg: any) => Effect.sync(() => (messages.push(msg), msg)),
        updatePart: (part: any) => Effect.sync(() => (parts.push(part), part)),
      } as any,
    }
  }
  const stuckTurn = () =>
    [user("u1"), assistant("a1", "u1", [bash("npm test", 1, "Error: boom"), bash("npm test", 1, "Error: boom"), bash("npm test", 1, "Error: boom")])] as any

  test("adds a synthetic message on the session's tier that says what failed and that the turn moves", async () => {
    const store = fake()
    const msgs = stuckTurn()
    const meta = await Effect.runPromise(
      StuckTurn.afterStep({ user: msgs[0].info, messages: msgs, sessions: store.sessions, route: { tier: "rafiki-pro", escalated: true }, env: {} }),
    )
    expect(meta?.escalated).toEqual({ from: "rafiki-fast", to: "rafiki-pro" })
    expect(store.messages[0].model).toEqual({ providerID: "rafiki", modelID: "rafiki-fast" })
    expect(store.parts[0].synthetic).toBe(true)
    expect(store.parts[0].text).toContain("failed the same way 3 times")
    expect(store.parts[0].text).toContain("Error: boom")
    expect(store.parts[0].text).toContain("continues on rafiki-pro")
    expect(Stuck.userLine(meta!)).toBe("Stuck: `npm test` failed the same way 3 times; changing approach, now on rafiki-pro.")
  })

  test("without escalation the line says only that the approach changes; RAFIKICODE_STUCK=off turns it off", async () => {
    const store = fake()
    const msgs = stuckTurn()
    const meta = await Effect.runPromise(
      StuckTurn.afterStep({ user: msgs[0].info, messages: msgs, sessions: store.sessions, route: { tier: "rafiki-pro", escalated: false }, env: {} }),
    )
    expect(Stuck.userLine(meta!)).toBe("Stuck: `npm test` failed the same way 3 times; changing approach.")
    const off = await Effect.runPromise(
      StuckTurn.afterStep({ user: msgs[0].info, messages: msgs, sessions: fake().sessions, env: { RAFIKICODE_STUCK: "off" } }),
    )
    expect(off).toBeUndefined()
  })
})
