// The tier of each request by task (src/rafiki/routing.ts). The rules first,
// then `rafikicode run` against the mock gateway:
//
//   - `--deep` sends the turn to rafiki-pro, says so on the JSON step events,
//     and the next turn goes back to the session's tier;
//   - on a large context the escalated turn compacts first, the summary on
//     rafiki-fast;
//   - an explore subagent of an unpinned session on rafiki-pro runs on
//     rafiki-fast, while the session's own requests stay on rafiki-pro.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Routing from "../../src/rafiki/routing"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")

describe("the rules", () => {
  const base = { providerID: Brand.provider.id, env: {} as Record<string, string | undefined> }

  test("a turn stays on the session's tier without a signal, whatever its size", () => {
    for (const tier of Brand.models) {
      const decision = Routing.choose({ ...base, purpose: "turn", tier, pinned: false })
      expect(decision).toEqual({ tier, reason: "session tier", escalated: false })
    }
  })

  test("a difficulty signal escalates an unpinned turn to rafiki-pro, never to rafiki-max", () => {
    for (const signal of ["deep", "plan", "failing", "review"] as const) {
      const decision = Routing.choose({ ...base, purpose: "turn", tier: "rafiki-fast", pinned: false, signal })
      expect(decision.tier).toBe("rafiki-pro")
      expect(decision.escalated).toBe(true)
      expect(decision.reason.startsWith(signal + ":")).toBe(true)
    }
    // Already on pro or max: not moved, max is never lowered either.
    expect(Routing.choose({ ...base, purpose: "turn", tier: "rafiki-pro", pinned: false, signal: "deep" }).escalated).toBe(false)
    expect(Routing.choose({ ...base, purpose: "turn", tier: "rafiki-max", pinned: false, signal: "deep" }).tier).toBe("rafiki-max")
  })

  test("a pinned tier moves only on /deep", () => {
    expect(Routing.choose({ ...base, purpose: "turn", tier: "rafiki-fast", pinned: true, signal: "plan" })).toEqual({
      tier: "rafiki-fast",
      reason: "pinned tier",
      escalated: false,
    })
    expect(Routing.choose({ ...base, purpose: "turn", tier: "rafiki-fast", pinned: true, signal: "deep" }).tier).toBe("rafiki-pro")
    expect(Routing.choose({ ...base, purpose: "compaction", tier: "rafiki-pro", pinned: true }).tier).toBe("rafiki-pro")
    expect(Routing.choose({ ...base, purpose: "title", tier: "rafiki-max", pinned: true }).tier).toBe("rafiki-max")
  })

  test("exploration, titles and summaries of an unpinned session go to rafiki-fast", () => {
    for (const tier of ["rafiki-pro", "rafiki-max"]) {
      expect(Routing.choose({ ...base, purpose: "subagent", agent: "explore", tier, pinned: false }).tier).toBe("rafiki-fast")
      expect(Routing.choose({ ...base, purpose: "title", tier, pinned: false }).tier).toBe("rafiki-fast")
      expect(Routing.choose({ ...base, purpose: "compaction", tier, pinned: false })).toEqual({
        tier: "rafiki-fast",
        reason: "compaction summary: rafiki-fast",
        escalated: false,
      })
    }
    // Another subagent keeps the session's tier; a review subagent goes to pro.
    expect(Routing.choose({ ...base, purpose: "subagent", agent: "general", tier: "rafiki-pro", pinned: false }).tier).toBe("rafiki-pro")
    expect(Routing.choose({ ...base, purpose: "subagent", agent: "general", tier: "rafiki-fast", pinned: false, signal: "review" }).tier).toBe("rafiki-pro")
  })

  test("other providers and RAFIKICODE_ROUTING=off are left alone", () => {
    expect(Routing.choose({ ...base, providerID: "other", purpose: "turn", tier: "rafiki-fast", pinned: false, signal: "deep" }).tier).toBe("rafiki-fast")
    for (const value of ["0", "off", "false"]) {
      const env = { [Brand.env.routing]: value }
      expect(Routing.enabled(env)).toBe(false)
      expect(Routing.choose({ ...base, env, purpose: "compaction", tier: "rafiki-pro", pinned: false }).tier).toBe("rafiki-pro")
    }
    expect(Routing.enabled({})).toBe(true)
  })

  test("a wide change, for plan mode", () => {
    expect(Routing.wide("Refactor the storage layer to use one connection pool")).toBe(true)
    expect(Routing.wide("Rename the flag across all packages")).toBe(true)
    expect(Routing.wide("Update every module that imports the logger")).toBe(true)
    expect(Routing.wide("touch src/a.ts src/b.ts lib/c.ts lib/d.ts test/e.ts")).toBe(true)
    expect(Routing.wide("Fix the typo in src/a.ts")).toBe(false)
    expect(Routing.wide("Add a --verbose option to the build script")).toBe(false)
  })

  test("signals of a turn: a command, the same check failing twice, plan on a wide change", () => {
    Routing.reset()
    const input = { sessionID: "ses_signal", agent: "build", text: "Fix the bug", failures: [] as string[][] }
    expect(Routing.signalOf(input)).toBeUndefined()
    expect(Routing.signalOf({ ...input, failures: [["bun test"]] })).toBeUndefined()
    expect(Routing.signalOf({ ...input, failures: [["bun test"], ["bun run lint"]] })).toBeUndefined()
    expect(Routing.signalOf({ ...input, failures: [["bun test", "tsc"], ["bun test"]] })).toBe("failing")
    expect(Routing.signalOf({ ...input, agent: "plan", text: "Migrate the whole codebase to ESM" })).toBe("plan")
    expect(Routing.signalOf({ ...input, agent: "build", text: "Migrate the whole codebase to ESM" })).toBeUndefined()
    Routing.request("ses_signal", "deep")
    expect(Routing.signalOf(input)).toBe("deep")
    Routing.endTurn("ses_signal")
    expect(Routing.signalOf(input)).toBeUndefined()
  })

  test("pro takes the same reasoning effort variants as fast", () => {
    expect(Brand.provider.takesEffort("rafiki-pro")).toBe(Brand.provider.takesEffort("rafiki-fast"))
    expect(Brand.provider.takesEffort("rafiki-pro")).toBe(true)
  })
})

// About 70,000 tokens at 4 characters a token.
const BIG = Array.from({ length: 28_000 }, (_, index) => `line${String(index).padStart(5, "0")}`).join(" ")

type Gateway = ReturnType<typeof createMockGateway>
type Body = { raw: Buffer; json: any; session?: string }

let homes: string[] = []
let gateways: Gateway[] = []

afterEach(async () => {
  await Promise.all(gateways.map((gateway) => gateway.close()))
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true })
  homes = []
  gateways = []
})

async function setup(options: Record<string, unknown> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-routing-"))
  const repo = path.join(home, "repo")
  fs.mkdirSync(repo)
  spawnSync("git", ["init", "-q"], { cwd: repo })
  const gateway = createMockGateway({
    quiet: true,
    bodies: true,
    usage: (_body: unknown, tokens: number) => ({ prompt_tokens: tokens, completion_tokens: 8, total_tokens: tokens + 8 }),
    ...options,
  })
  await gateway.ready
  homes.push(home)
  gateways.push(gateway)
  return { home, repo, gateway }
}

type Side = Awaited<ReturnType<typeof setup>>

async function run(side: Side, args: string[], input?: string) {
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
    RAFIKICODE_API_KEY: "sk-routing-stub",
  }
  for (const name of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_DB", "RAFIKICODE_CONSOLE_URL", Brand.env.headless, Brand.env.trustWorkspace, Brand.env.routing])
    delete env[name]
  const session = (gateway.bodies as Body[]).find((body) => body.session)?.session
  const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "run", ...(session ? ["--session", session] : []), ...args], {
    cwd: repo,
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { exitCode: await proc.exited, stdout, all: stdout + stderr }
}

const chats = (gateway: Gateway) => (gateway.requests as any[]).filter((entry) => entry.path === "/v1/chat/completions")
const task = (gateway: Gateway) => chats(gateway).filter((entry) => entry.tools > 0)
const isCompaction = (body: Body) => JSON.stringify(body.json.messages).includes("Here is the conversation so far")
const events = (stdout: string) =>
  stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))

describe("rafikicode run against the mock gateway", () => {
  test(
    "--deep: the turn on rafiki-pro with the reason on its step events, the next turn back on the session's tier",
    async () => {
      const side = await setup()
      const deep = await run(side, ["--deep", "--format", "json", "Find why the parser drops the last token."])
      expect(deep.exitCode, deep.all).toBe(0)
      expect(task(side.gateway).map((entry) => entry.model)).toEqual(["rafiki-pro"])
      const steps = events(deep.stdout).filter((event) => event.type === "step_start" || event.type === "step_finish")
      expect(steps.length).toBeGreaterThan(0)
      for (const step of steps) {
        expect(step.tier).toBe("rafiki-pro")
        expect(step.route).toBe("deep: asked for with /deep or --deep")
      }

      const next = await run(side, ["--format", "json", "Thanks, now list the files."])
      expect(next.exitCode, next.all).toBe(0)
      expect(task(side.gateway).at(-1)!.model).toBe("rafiki-fast")
      const after = events(next.stdout).filter((event) => event.type === "step_finish")
      expect(after.at(-1)!.tier).toBe("rafiki-fast")
      expect(after.at(-1)!.route).toBe("session tier")
    },
    240_000,
  )

  test(
    "an escalated turn on a context over 60,000 tokens compacts first, the summary on rafiki-fast",
    async () => {
      const side = await setup()
      const first = await run(side, ["Keep the log below for later, then answer ok."], BIG)
      expect(first.exitCode, first.all).toBe(0)
      expect(task(side.gateway).at(-1)!.tokens).toBeGreaterThan(Routing.COMPACT_FIRST)
      const before = (side.gateway.bodies as Body[]).length

      const deep = await run(side, ["--deep", "What was the first line of the log?"])
      expect(deep.exitCode, deep.all).toBe(0)
      const bodies = (side.gateway.bodies as Body[]).slice(before)
      const compaction = bodies.findIndex(isCompaction)
      expect(compaction).toBeGreaterThanOrEqual(0)
      expect(bodies[compaction].json.model).toBe("rafiki-fast")
      const escalated = bodies.slice(compaction + 1).filter((body) => Array.isArray(body.json.tools) && body.json.tools.length > 0)
      expect(escalated.length).toBeGreaterThan(0)
      for (const body of escalated) expect(body.json.model).toBe("rafiki-pro")
      expect(bodies.filter(isCompaction).length).toBe(1)
    },
    240_000,
  )

  test(
    "an explore subagent of an unpinned session on rafiki-pro runs on rafiki-fast",
    async () => {
      const side = await setup({
        respond: (body: any) => {
          const messages = body.messages ?? []
          const last = messages.at(-1)
          const tools = (body.tools ?? []).map((tool: any) => tool.function?.name)
          if (last?.role === "user" && tools.includes("task") && JSON.stringify(last).includes("EXPLORE_NOW"))
            return {
              toolCall: {
                name: "task",
                arguments: { description: "Look around", prompt: "List the files of the project.", subagent_type: "explore" },
              },
            }
          return undefined
        },
      })
      // The session's tier is pro (pinned for this first run).
      const first = await run(side, ["--model", "rafiki/rafiki-pro", "Answer ok."])
      expect(first.exitCode, first.all).toBe(0)
      const before = task(side.gateway).length

      // No tier named: unpinned, the session stays on pro and its explore subagent goes to fast.
      const second = await run(side, ["EXPLORE_NOW: use an explore subagent to list the files."])
      expect(second.exitCode, second.all).toBe(0)
      const requests = (side.gateway.bodies as Body[])
        .filter((body) => Array.isArray(body.json.tools) && body.json.tools.length > 0)
        .slice(before)
      // The subagent's conversation does not carry the session's message.
      const child = requests.filter((body) => !JSON.stringify(body.json.messages).includes("EXPLORE_NOW"))
      const parent = requests.filter((body) => !child.includes(body))
      expect(child.length).toBeGreaterThan(0)
      expect(parent.length).toBeGreaterThan(0)
      for (const body of child) expect(body.json.model).toBe("rafiki-fast")
      for (const body of parent) expect(body.json.model).toBe("rafiki-pro")
    },
    240_000,
  )
})
