// rafikicode run against the mock gateway with a stored login: the key and
// surface on every call, and the contract's messages and exit codes when the
// gateway refuses (budget, revocation, tier, CI).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { createMockConsole } from "../brand/mock-console.mjs"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
let home: string
let console_: ReturnType<typeof createMockConsole> | undefined
let gateway: ReturnType<typeof createMockGateway> | undefined

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-gw-"))
})

afterEach(async () => {
  await console_?.close()
  await gateway?.close()
  console_ = undefined
  gateway = undefined
  fs.rmSync(home, { recursive: true, force: true })
})

async function run(args: string[], extra: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    COLUMNS: "120",
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    RAFIKICODE_CONSOLE_URL: console_?.url,
    RAFIKICODE_GATEWAY_URL: gateway ? gateway.url + "/v1" : undefined,
    RAFIKICODE_TEST_TTY: "1",
  }
  delete env["XDG_CONFIG_HOME"]
  delete env["CI"]
  delete env["GITHUB_ACTIONS"]
  delete env["RAFIKICODE_API_KEY"]
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), ...args], {
    cwd: home,
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr, all: stdout + stderr }
}

const credentials = () => path.join(home, ".rafikicode", "credentials")

async function login(maxBudget = 1) {
  gateway = createMockGateway({ quiet: true, cost: 0.4 })
  await gateway.ready
  console_ = createMockConsole({ quiet: true, interval: 1, auto: "approve", autoAfter: 1, gatewayURL: gateway.url + "/v1" })
  await console_.ready
  const result = await run(["login", "--label", "gateway test"])
  expect(result.exitCode).toBe(0)
  const stored = JSON.parse(fs.readFileSync(credentials(), "utf8"))
  expect(stored.kind).toBe("session")
  // The mock Console minted the key itself; tell the mock gateway about it.
  const registered = await fetch(gateway.url + "/__test/register", {
    method: "POST",
    body: JSON.stringify({ key: stored.key, key_alias: stored.key_alias, models: ["rafiki-fast", "rafiki-pro"], max_budget: maxBudget }),
  })
  expect(registered.status).toBe(200)
  return stored
}

const chatCalls = () => gateway!.requests.filter((r: any) => r.path === "/v1/chat/completions")

describe("rafikicode run through the gateway", () => {
  test("carries the stored key and the surface header, on the tier alias, then hits the budget", async () => {
    const stored = await login(1)

    const ok = await run(["run", "say hello"])
    expect(ok.exitCode).toBe(0)
    expect(ok.stdout).toContain("Mock gateway reply")
    const first = chatCalls()[0]
    expect(first).toMatchObject({ authorization: "present", key_alias: stored.key_alias, model: "rafiki-fast", surface: "cli", status: 200 })
    expect(JSON.stringify(gateway!.requests)).not.toContain(stored.key)

    // Two calls at 0.4 each are under 1; the third is refused.
    await run(["run", "and again"])
    const broke = await run(["run", "one more"])
    expect(broke.exitCode).toBe(3)
    expect(broke.all).toContain("Your key has run out of budget.")
    expect(broke.all).toContain("/keys")
    expect(broke.all).not.toContain("Budget has been exceeded")
    expect(broke.all).not.toContain("    at ")
    expect(chatCalls().at(-1)).toMatchObject({ status: 429, error_type: "budget_exceeded" })
  }, 120_000)

  test("a revoked key and a tier the key may not use are named plainly", async () => {
    const stored = await login(10)

    const denied = await run(["run", "--model", "rafiki/rafiki-max", "try max"])
    expect(denied.exitCode).toBe(2)
    expect(denied.all).toContain("This key is not allowed to use the max tier.")
    expect(chatCalls().at(-1)).toMatchObject({ status: 403, error_type: "key_model_access_denied", model: "rafiki-max" })

    const revoked = await fetch(gateway!.url + "/key/delete", {
      method: "POST",
      headers: { authorization: "Bearer sk-master-mock" },
      body: JSON.stringify({ key_aliases: [stored.key_alias] }),
    })
    expect((await revoked.json()).deleted_keys).toEqual([stored.key_alias])

    const gone = await run(["run", "hello?"])
    expect(gone.exitCode).toBe(2)
    expect(gone.all).toContain("This key was revoked or has expired. Run rafikicode login.")
    expect(gone.all).not.toContain("token_not_found_in_db")
  }, 120_000)

  test("a stored browser sign-in is refused when CI is set, and the env key still wins", async () => {
    await login(10)

    const ci = await run(["models"], { CI: "1" })
    // No usable credential means no model: the sign-in hint and the contract's exit 2.
    expect(ci.exitCode).toBe(2)
    expect(ci.stdout).not.toContain("rafiki/")
    expect(ci.stderr).toContain("CI is set, so the stored browser sign-in is not used.")
    expect(ci.stderr).toContain("RAFIKICODE_API_KEY")
    expect(ci.all).toContain("No models available: not signed in.")

    const server = await run(["models"], { CI: "1", RAFIKICODE_API_KEY: "sk-server-key-for-ci" })
    expect(server.exitCode).toBe(0)
    expect(server.stdout).toContain("rafiki/rafiki-fast")
    expect(server.stderr).not.toContain("CI is set")
  }, 120_000)

  test("a gateway that cannot be reached exits 4 with a plain message", async () => {
    // A port that was just free: nothing listens, so the connection is refused.
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
    const port = probe.port
    probe.stop(true)
    const started = Date.now()
    const result = await run(["run", "hello"], {
      RAFIKICODE_API_KEY: "sk-unreachable-stub",
      RAFIKICODE_GATEWAY_URL: `http://127.0.0.1:${port}/v1`,
    })
    expect(result.exitCode).toBe(4)
    expect(result.all).toContain(`Cannot reach the model gateway at http://127.0.0.1:${port}/v1`)
    expect(result.all).toContain("RAFIKICODE_GATEWAY_URL which is set")
    expect(result.all).not.toContain("sk-unreachable-stub")
    expect(result.all).not.toContain("    at ")
    const seconds = (Date.now() - started) / 1000
    console.log(`unreachable gateway run took ${Math.round(seconds)} s (one connection retry)`)
    // rc3 waited about 70 s on upstream retries; the rafiki provider retries a
    // connection failure once. The bound leaves room for a cold bun start.
    expect(seconds).toBeLessThan(20)
  }, 180_000)
})
