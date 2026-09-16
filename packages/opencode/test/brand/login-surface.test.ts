// Editor sign in (contract, Device flow): rafikicode login --surface ide asks
// the Console for a device code as surface ide, the only other value the
// Console accepts besides cli. ACP terminal auth and the VS Code extension run
// that form, so the Console key list shows where a key is used.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import * as Contract from "../../src/rafiki/contract"
import * as DeviceFlow from "../../src/rafiki/device-flow"
import * as RafikiACP from "../../src/rafiki/acp"
import { createMockConsole } from "./mock-console.mjs"

const root = path.resolve(import.meta.dir, "../..")
let home: string
let mock: ReturnType<typeof createMockConsole> | undefined

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-surface-"))
})

afterEach(async () => {
  await mock?.close()
  mock = undefined
  fs.rmSync(home, { recursive: true, force: true })
})

async function run(args: string[]) {
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
    RAFIKICODE_CONSOLE_URL: mock?.url ?? "http://127.0.0.1:9",
    RAFIKICODE_TEST_TTY: "1",
  }
  for (const name of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "RAFIKICODE_API_KEY"]) delete env[name]
  const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), ...args], {
    cwd: home,
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { exitCode: await proc.exited, stdout, stderr, all: stdout + stderr }
}

describe("sign in surface", () => {
  test("the contract names cli and ide, cli by default", () => {
    expect([...Contract.SURFACES]).toEqual(["cli", "ide"])
    expect(Contract.SURFACE).toBe("cli")
    expect(Contract.isSurface("cli")).toBe(true)
    expect(Contract.isSurface("ide")).toBe(true)
    for (const value of ["builder", "server", "IDE", "", undefined, 1]) expect(Contract.isSurface(value)).toBe(false)
  })

  test("the default device label says when the sign in is for an editor", () => {
    expect(DeviceFlow.deviceLabel("0.1.3")).toMatch(/^rafikicode 0\.1\.3 on .+/)
    expect(DeviceFlow.deviceLabel("0.1.3", undefined, "ide")).toMatch(/^rafikicode 0\.1\.3 in an editor on .+/)
    expect(DeviceFlow.deviceLabel("0.1.3", "Zed on laptop", "ide")).toBe("Zed on laptop")
  })

  test("requestCode sends the surface, and refuses an unknown one before any request", async () => {
    mock = createMockConsole({ quiet: true, interval: 1 })
    await mock.ready
    const c = DeviceFlow.client({ consoleURL: mock.url })
    await DeviceFlow.requestCode(c, { label: "editor", surface: "ide" })
    await DeviceFlow.requestCode(c, { label: "terminal" })
    const codes = mock.requests.filter((r: any) => r.path === Contract.PATH.deviceCode)
    expect(codes.map((r: any) => r.surface)).toEqual(["ide", "cli"])

    const err = await DeviceFlow.requestCode(c, { label: "x", surface: "builder" as Contract.Surface }).catch((e) => e)
    expect(err).toBeInstanceOf(DeviceFlow.DeviceFlowError)
    expect(err.exitCode).toBe(Contract.EXIT.usage)
    expect(err.message).toBe('Unknown sign in surface "builder". Use --surface cli or --surface ide.')
    expect(mock.requests.filter((r: any) => r.path === Contract.PATH.deviceCode)).toHaveLength(2)
  })

  test("ACP terminal auth runs login as surface ide", () => {
    expect(RafikiACP.loginArgs()).toEqual(["login", "--surface", "ide"])
  })

  test("login --surface ide signs in through the Console as ide", async () => {
    mock = createMockConsole({ quiet: true, interval: 1, auto: "approve", autoAfter: 1 })
    await mock.ready
    const login = await run(["login", "--surface", "ide"])
    expect(login.exitCode).toBe(0)
    expect(login.all).toContain("Signed in")
    expect(login.all).toMatch(/Approving as: rafikicode \S+ in an editor on /)
    const request = mock.requests.find((r: any) => r.path === Contract.PATH.deviceCode) as any
    expect(request.surface).toBe("ide")
    expect(request.label).toContain("in an editor on")
    expect(login.all).not.toContain("sk-mock-")
    expect(fs.statSync(path.join(home, ".rafikicode", "credentials")).mode & 0o777).toBe(0o600)
  }, 120_000)

  test("login without --surface stays cli", async () => {
    mock = createMockConsole({ quiet: true, interval: 1, auto: "approve", autoAfter: 1 })
    await mock.ready
    const login = await run(["login", "--label", "plain terminal"])
    expect(login.exitCode).toBe(0)
    expect(mock.requests.find((r: any) => r.path === Contract.PATH.deviceCode)).toMatchObject({ surface: "cli", label: "plain terminal" })
  }, 120_000)

  test("an unknown surface is refused before the Console is called", async () => {
    mock = createMockConsole({ quiet: true, interval: 1 })
    await mock.ready
    for (const value of ["builder", "IDE", ""]) {
      const login = await run(["login", "--surface", value])
      expect(login.exitCode).toBe(2)
      expect(login.all).toContain(`Unknown sign in surface ${JSON.stringify(value)}. Use --surface cli or --surface ide.`)
    }
    expect(mock.requests.filter((r: any) => r.path === Contract.PATH.deviceCode)).toHaveLength(0)
    expect(fs.existsSync(path.join(home, ".rafikicode", "credentials"))).toBe(false)
  }, 120_000)

  test("login --help lists the surface option", async () => {
    const help = await run(["login", "--help"])
    expect(help.exitCode).toBe(0)
    expect(help.all).toContain("--surface")
    expect(help.all).toContain("where the key is used: cli for a terminal, ide for an editor")
    expect(help.all).toContain('[default: "cli"]')
  }, 60_000)
})
