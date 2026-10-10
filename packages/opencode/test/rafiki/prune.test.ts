// Pruning of old tool output (src/rafiki/prune.ts): a long session sends
// fewer bytes per request, and the model still gets what it needs.
//
// The end to end test runs nine turns of one session with `rafikicode run`
// (`--session` after the first) against the mock gateway, twice side by side:
// pruning on (the default on a Rafiki tier) and off (RAFIKICODE_PRUNE=0).
// Every turn the gateway asks for one tool call: a failing command with a
// large output, a file write, then large command outputs. The request bodies
// are compared as the gateway received them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { Brand } from "@opencode-ai/core/brand/brand"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import * as Prune from "../../src/rafiki/prune"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const KEY = "sk-prune-stub"
const TURNS = 9
// One line of about 45,000 characters (about 11,000 tokens), under the 50 KB
// and 2,000 line limits, so the tool returns it whole.
const big = (tag: string) => `seq -s ' ' -f '${tag}-%05g' 1 3750`
const FAILING = `${big("failed")}; exit 3`
const NOTE = "Remember: the release branch is release/1.4."

function callFor(turn: number, repo: string) {
  if (turn === 1) return { name: "bash", arguments: { command: FAILING, description: "Show the failing check" } }
  if (turn === 2)
    return { name: "write", arguments: { filePath: path.join(repo, "notes.md"), content: NOTE + "\n" } }
  return { name: "bash", arguments: { command: big(`turn${turn}`), description: "Print the build log" } }
}

type Body = { raw: Buffer; json: any; session?: string }

function setup(label: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `rafikicode-prune-${label}-`))
  const repo = path.join(home, "repo")
  fs.mkdirSync(repo)
  spawnSync("git", ["init", "-q"], { cwd: repo })
  const gateway = createMockGateway({
    quiet: true,
    bodies: true,
    toolCallEach: (turn: number) => callFor(turn, repo),
  })
  return { home, repo, gateway }
}

type Side = ReturnType<typeof setup>

async function turn(side: Side, n: number, extra: Record<string, string | undefined>) {
  const { home, repo, gateway } = side
  const env: Record<string, string | undefined> = {
    ...process.env,
    COLUMNS: "120",
    PWD: repo,
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    RAFIKICODE_GATEWAY_URL: gateway.url + "/v1",
    RAFIKICODE_API_KEY: KEY,
  }
  // The test preload keeps the database in memory; the session must outlive one run here.
  for (const k of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION", "OPENCODE_DISABLE_PRUNE", "OPENCODE_DB", Brand.env.headless, Brand.env.trustWorkspace, Brand.env.prune]) delete env[k]
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  // The session of the first turn, as the gateway saw it.
  const session = (gateway.bodies as Body[]).find((body) => body.session)?.session
  if (n > 1) expect(session).toMatch(/^ses_/)
  const args = ["run", "--model", "rafiki/rafiki-fast", ...(n > 1 ? ["--session", session!] : []), `Turn ${n}: run the next check, then stop.`]
  const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), ...args], {
    cwd: repo,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { exitCode: await proc.exited, all: stdout + stderr }
}

// The task requests (the ones with tool definitions), grouped by turn: the
// first request of a turn ends with the user's message.
function turns(side: Side) {
  const task = (side.gateway.bodies as Body[]).filter((body) => Array.isArray(body.json.tools) && body.json.tools.length > 0)
  const result: Body[][] = []
  for (const body of task) {
    const last = body.json.messages[body.json.messages.length - 1]
    if (last?.role === "user") result.push([body])
    else result[result.length - 1]?.push(body)
  }
  return result
}

function toolResults(body: Body): string[] {
  return body.json.messages
    .filter((message: any) => message.role === "tool")
    .map((message: any) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
}

describe("a long session against the mock gateway: pruning on and off", () => {
  let on: Side
  let off: Side

  beforeAll(async () => {
    on = setup("on")
    off = setup("off")
    await Promise.all([on.gateway.ready, off.gateway.ready])
  })

  afterAll(async () => {
    await Promise.all([on.gateway.close(), off.gateway.close()])
    for (const side of [on, off]) fs.rmSync(side.home, { recursive: true, force: true })
  })

  test(
    "later turns send fewer bytes, and what the model needs is still sent in full",
    async () => {
      for (let n = 1; n <= TURNS; n++) {
        const [a, b] = await Promise.all([turn(on, n, {}), turn(off, n, { [Brand.env.prune]: "0" })])
        expect(a.exitCode, a.all).toBe(0)
        expect(b.exitCode, b.all).toBe(0)
      }
      const onTurns = turns(on)
      const offTurns = turns(off)
      expect(onTurns.length).toBe(TURNS)
      expect(offTurns.length).toBe(TURNS)
      for (const group of [...onTurns, ...offTurns]) expect(group.length).toBe(2)

      // Up to the first batch both sessions send the same conversation.
      for (let n = 0; n < TURNS - 1; n++) {
        expect(Math.abs(onTurns[n][0].raw.length - offTurns[n][0].raw.length)).toBeLessThan(200)
      }

      // The last turn: two old outputs of about 45,000 characters each are replaced.
      const [first, second] = onTurns[TURNS - 1]
      const [offFirst, offSecond] = offTurns[TURNS - 1]
      const saved = offFirst.raw.length - first.raw.length
      expect(saved).toBeGreaterThan(80_000)
      expect(offSecond.raw.length - second.raw.length).toBeGreaterThan(80_000)
      expect(first.raw.length).toBeLessThan(offFirst.raw.length * 0.75)

      const results = toolResults(second)
      expect(results.length).toBe(TURNS)
      const replaced = results.filter((text) => text.includes("removed to keep the conversation short"))
      expect(replaced.length).toBe(2)
      for (const [index, n] of [
        [0, 3],
        [1, 4],
      ] as const) {
        const text = results.find((item) => item.includes(`turn${n}-%05g`))!
        expect(text).toBe(replaced[index])
        expect(text).toContain(`[Output of an earlier bash call (command: ${big(`turn${n}`)}) removed`)
        expect(text).toContain("Run the call again if you need it.")
        expect(text).not.toContain(`turn${n}-00001`)
      }
      // The failing command and the file write are kept as they were.
      expect(results[0]).toContain("failed-03750")
      expect(results[1]).toBe("Wrote file successfully.")
      expect(JSON.stringify(second.json.messages)).toContain(NOTE)
      // The newest outputs, the latest turn's above all, are sent in full.
      for (let n = 5; n <= TURNS; n++) expect(results[n - 1]).toContain(`turn${n}-03750`)

      // Off sends everything.
      for (const text of toolResults(offSecond)) expect(text).not.toContain("removed to keep the conversation short")

      // Once replaced, the bytes stay put: the pruned turn's two requests share the conversation prefix.
      const prefix = (body: Body) => body.json.messages.slice(0, first.json.messages.length)
      expect(prefix(second)).toEqual(prefix(first))
    },
    600_000,
  )
})

// The rule on its own, without a session.
function user(id: string): SessionV1.WithParts {
  return {
    info: { id, role: "user", sessionID: "s", agent: "build", model: { providerID: "rafiki", modelID: "rafiki-fast" }, time: { created: 0 } },
    parts: [],
  } as unknown as SessionV1.WithParts
}

function assistant(id: string, tools: { tool: string; size: number; status?: "completed" | "error"; exit?: number; compacted?: number }[]) {
  return {
    info: { id, role: "assistant", sessionID: "s" },
    parts: tools.map((item, index) => ({
      id: `${id}-${index}`,
      type: "tool",
      tool: item.tool,
      callID: `${id}-${index}`,
      state:
        item.status === "error"
          ? { status: "error", input: {}, error: "x".repeat(item.size), time: { start: 0, end: 1 } }
          : {
              status: "completed",
              input: { command: `cmd ${id}` },
              output: "x".repeat(item.size),
              title: "",
              metadata: item.exit === undefined ? {} : { exit: item.exit },
              time: { start: 0, end: 1, ...(item.compacted ? { compacted: item.compacted } : {}) },
            },
    })),
  } as unknown as SessionV1.WithParts
}

const TOKENS = 4 // characters per estimated token

describe("the rule", () => {
  test("enabled: the env var, then the config, then on for the Rafiki provider only", () => {
    expect(Brand.env.prune).toBe("RAFIKICODE_PRUNE")
    expect(Prune.enabled({ configured: undefined, providerID: Brand.provider.id, env: {} })).toBe(true)
    expect(Prune.enabled({ configured: undefined, providerID: "other", env: {} })).toBe(false)
    expect(Prune.enabled({ configured: false, providerID: Brand.provider.id, env: {} })).toBe(false)
    expect(Prune.enabled({ configured: true, providerID: "other", env: {} })).toBe(true)
    for (const value of ["0", "off", "false", "OFF"])
      expect(Prune.enabled({ configured: true, providerID: Brand.provider.id, env: { RAFIKICODE_PRUNE: value } })).toBe(false)
    for (const value of ["1", "on", "true"])
      expect(Prune.enabled({ configured: false, providerID: "other", env: { RAFIKICODE_PRUNE: value } })).toBe(true)
    expect(Prune.enabled({ configured: undefined, providerID: Brand.provider.id, env: { RAFIKICODE_PRUNE: "maybe" } })).toBe(true)
  })

  test("marker: the call, its input and its size, the same bytes every time", () => {
    const part = { tool: "read", state: { input: { filePath: "src/a.ts", offset: 1 }, output: "y".repeat(48_894) } }
    const text = Prune.marker(part)
    expect(text).toBe(
      "[Output of an earlier read call (filePath: src/a.ts) removed to keep the conversation short: 48,894 characters. Run the call again if you need it.]",
    )
    expect(Prune.marker(part)).toBe(text)
    const long = Prune.marker({ tool: "bash", state: { input: { command: "echo " + "a".repeat(400) + "\n  b" }, output: "" } })
    expect(long).toContain("(command: echo aaaa")
    expect(long).toContain("...) removed")
    expect(long).toContain(": 0 characters.")
    expect(Prune.marker({ tool: "webfetch", state: { input: {}, output: "z" } })).toBe(
      "[Output of an earlier webfetch call removed to keep the conversation short: 1 characters. Run the call again if you need it.]",
    )
  })

  const size = 11_000 * TOKENS

  test("the latest turn and the newest 40,000 tokens are kept; older large outputs go in one batch", () => {
    const msgs = [
      user("u1"),
      assistant("a1", [{ tool: "bash", size }]),
      user("u2"),
      assistant("a2", [{ tool: "bash", size }]),
      user("u3"),
      assistant("a3", [{ tool: "bash", size }, { tool: "bash", size }, { tool: "bash", size }]),
      user("u4"),
      assistant("a4", [{ tool: "bash", size: size * 3 }]),
      user("u5"),
    ]
    const found = Prune.select(msgs)
    expect(found.parts.map((part) => String(part.id))).toEqual(["a2-0", "a1-0"])
    expect(found.pruned).toBe(22_000)
  })

  test("nothing happens below the 20,000 token minimum", () => {
    const msgs = [user("u1"), assistant("a1", [{ tool: "bash", size }]), user("u2"), assistant("a2", [{ tool: "bash", size: 40_000 * TOKENS }]), user("u3"), assistant("a3", [{ tool: "bash", size }]), user("u4")]
    const found = Prune.select(msgs)
    expect(found.pruned).toBe(11_000)
    expect(found.parts).toEqual([])
  })

  test("errors, failed commands, edits, skills and small outputs are never replaced", () => {
    const old = [
      { tool: "bash", size, exit: 2 },
      { tool: "bash", size, status: "error" as const },
      { tool: "edit", size },
      { tool: "write", size },
      { tool: "apply_patch", size },
      { tool: "skill", size },
      { tool: "todowrite", size },
      { tool: "grep", size: 400 * TOKENS },
      { tool: "read", size },
      { tool: "bash", size, exit: 0 },
    ]
    const msgs = [
      user("u1"),
      assistant("a1", old),
      user("u2"),
      assistant("a2", [{ tool: "read", size: 40_000 * TOKENS }]),
      user("u3"),
      assistant("a3", [{ tool: "read", size }]),
      user("u4"),
    ]
    const found = Prune.select(msgs, { minimum: 0 })
    expect(found.parts.map((part) => String(part.id)).toSorted()).toEqual(["a1-8", "a1-9"])
  })

  test("stops at outputs already replaced and at a compaction summary", () => {
    const msgs = [
      user("u1"),
      assistant("a1", [{ tool: "bash", size }]),
      user("u2"),
      assistant("a2", [{ tool: "bash", size, compacted: 1 }]),
      user("u3"),
      assistant("a3", [{ tool: "bash", size: 30_000 * TOKENS }]),
      user("u4"),
      assistant("a4", [{ tool: "bash", size }]),
      user("u5"),
    ]
    expect(Prune.select(msgs, { minimum: 0 }).parts).toEqual([])
    const summary = { ...assistant("s", []), info: { id: "s", role: "assistant", summary: true } } as unknown as SessionV1.WithParts
    const withSummary = [user("u0"), assistant("a0", [{ tool: "bash", size: 60_000 * TOKENS }]), summary, ...msgs.slice(4)]
    expect(Prune.select(withSummary, { minimum: 0 }).parts).toEqual([])
  })
})
