// rafikicode login, whoami, logout as subprocesses against the mock Console.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { createMockConsole } from "../brand/mock-console.mjs"

const root = path.resolve(import.meta.dir, "../..")
let home: string
let mock: ReturnType<typeof createMockConsole> | undefined

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-cli-"))
})

afterEach(async () => {
  await mock?.close()
  mock = undefined
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
    RAFIKICODE_CONSOLE_URL: mock?.url,
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
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr, all: stdout + stderr }
}

const credentials = () => path.join(home, ".rafikicode", "credentials")

describe("rafikicode login, whoami, logout", () => {
  test("full cycle against the mock Console", async () => {
    mock = createMockConsole({ quiet: true, interval: 1, auto: "approve", autoAfter: 2 })
    await mock.ready

    const login = await run(["login", "--label", "test terminal"])
    expect(login.exitCode).toBe(0)
    expect(login.all).toContain(`${mock.url}/device`)
    expect(login.all).toMatch(/[BCDFGHJKMNPQRSTVWXZ]{4}-[BCDFGHJKMNPQRSTVWXZ]{4}/)
    expect(login.all).toContain("Signed in")
    expect(login.all).toContain("jane@example.com")
    expect(login.all).not.toContain("sk-mock-")
    expect(fs.statSync(credentials()).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(credentials())).mode & 0o777).toBe(0o700)
    const stored = JSON.parse(fs.readFileSync(credentials(), "utf8"))
    expect(stored.key).toStartWith("sk-mock-")
    expect(stored.key_alias).toStartWith("rafikicode-")
    expect(mock.requests.find((r: any) => r.path === "/api/v1/device/code")).toMatchObject({ label: "test terminal" })

    const models = await run(["models"])
    expect(models.exitCode).toBe(0)
    expect(models.stdout).toContain("rafiki/rafiki-fast")

    const whoami = await run(["whoami"])
    expect(whoami.exitCode).toBe(0)
    expect(whoami.all).toContain("jane@example.com")
    expect(whoami.all).toContain(stored.key_alias)
    expect(whoami.all).toContain("12.4 USD")
    expect(whoami.all).not.toContain(stored.key)

    const offline = await run(["whoami", "--offline"])
    expect(offline.exitCode).toBe(0)
    expect(offline.all).toContain("expires in")
    expect(offline.all).not.toContain(stored.key)

    const logout = await run(["logout"])
    expect(logout.exitCode).toBe(0)
    expect(logout.all).toContain("Revoked key")
    expect(logout.all).toContain("Signed out")
    expect(fs.existsSync(credentials())).toBe(false)
    expect([...mock.keys.values()].every((k: any) => k.revoked)).toBe(true)

    const again = await run(["logout"])
    expect(again.exitCode).toBe(0)
    expect(again.all).toContain("Not signed in")

    const nobody = await run(["whoami"])
    expect(nobody.exitCode).toBe(2)
    expect(nobody.all).toContain("rafikicode login")
  }, 120_000)

  test("signing in again revokes the previous key", async () => {
    mock = createMockConsole({ quiet: true, interval: 1, auto: "approve", autoAfter: 1 })
    await mock.ready

    const first = await run(["login", "--label", "first terminal"])
    expect(first.exitCode).toBe(0)
    const before = JSON.parse(fs.readFileSync(credentials(), "utf8"))

    const second = await run(["login", "--label", "second terminal"])
    expect(second.exitCode).toBe(0)
    expect(second.all).toContain("Signed in")
    expect(second.all).toContain(`Revoked the previous key ${before.key_alias}`)
    const after = JSON.parse(fs.readFileSync(credentials(), "utf8"))
    expect(after.key).not.toBe(before.key)

    const keys = [...mock.keys.values()] as any[]
    expect(keys.length).toBe(2)
    expect(keys.find((k) => k.id === before.key_id)?.revoked).toBe(true)
    expect(keys.find((k) => k.id === after.key_id)?.revoked).toBe(false)
    const revokes = mock.requests.filter((r: any) => r.method === "DELETE")
    expect(revokes.length).toBe(1)
  }, 120_000)

  test("denied in the browser", async () => {
    mock = createMockConsole({ quiet: true, interval: 1, auto: "deny", autoAfter: 1 })
    await mock.ready
    const login = await run(["login"])
    expect(login.exitCode).toBe(1)
    expect(login.all).toContain("denied in the browser")
    expect(fs.existsSync(credentials())).toBe(false)
  }, 60_000)

  test("headless environments point at the API key instead of polling", async () => {
    mock = createMockConsole({ quiet: true, interval: 1 })
    await mock.ready
    const noTTY = await run(["login"], { RAFIKICODE_TEST_TTY: undefined })
    expect(noTTY.exitCode).toBe(2)
    expect(noTTY.all).toContain("RAFIKICODE_API_KEY")
    expect(noTTY.all).toContain("/keys")
    const ci = await run(["login"], { CI: "1" })
    expect(ci.exitCode).toBe(2)
    expect(ci.all).toContain("CI environment")
    expect(mock.requests.length).toBe(0)

    const withKey = await run(["login"], { RAFIKICODE_API_KEY: "sk-server-stub" })
    expect(withKey.exitCode).toBe(2)
    expect(withKey.all).toContain("already authenticated")
    const whoami = await run(["whoami", "--offline"], { RAFIKICODE_API_KEY: "sk-server-stub" })
    expect(whoami.exitCode).toBe(0)
    expect(whoami.all).toContain("RAFIKICODE_API_KEY (environment)")
    expect(whoami.all).not.toContain("sk-server-stub")
  }, 90_000)
})

describe("rafikicode models without a credential", () => {
  test("prints one sign-in hint line and exits 2", async () => {
    const result = await run(["models"])
    expect(result.exitCode).toBe(2)
    expect(result.stdout).not.toContain("/")
    const hint = result.all.split("\n").filter((line) => line.includes("rafikicode login"))
    expect(hint).toHaveLength(1)
    expect(hint[0]).toContain("No models available: not signed in.")
    expect(hint[0]).toContain("RAFIKICODE_API_KEY")

    // With a key the provider is there and the hint is not.
    const withKey = await run(["models"], { RAFIKICODE_API_KEY: "sk-models-stub" })
    expect(withKey.exitCode).toBe(0)
    expect(withKey.stdout).toContain("rafiki/rafiki-fast")
    expect(withKey.all).not.toContain("No models available")
  }, 120_000)
})
