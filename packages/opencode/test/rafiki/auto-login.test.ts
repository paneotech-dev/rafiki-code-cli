// A command that needs a key, started with none: at a terminal it runs the
// browser sign-in of rafikicode login in place and carries on; without one
// (CI, a pipe, --format json, RAFIKICODE_NO_AUTO_LOGIN=1) it stops with the
// same message and exit code as before. Subprocesses have no terminal, so
// RAFIKICODE_TEST_AUTO_LOGIN=1 stands in for one; RAFIKICODE_TEST_TTY, which
// most CLI tests set, is set here too and must not start a sign-in. The
// provider scope is closed, as in a release build.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as DeviceFlow from "@opencode-ai/core/brand/device-flow"
import { autoSignIn, signInAgain, signInHere } from "../../src/rafiki/cmd"
import { createMockConsole } from "../brand/mock-console.mjs"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
// The message from before this change, word for word, for the given Console.
const oldMessage = (url: string) =>
  [
    `Error: Rafiki Code needs a Rafiki AI account. Create one in the Rafiki AI console (${url}), then run: rafikicode login`,
    `On a server or in CI, create an API key at ${url}/keys with the Rafiki Code option ticked, and set RAFIKICODE_API_KEY.`,
  ].join("\n")

let home: string
let console_: ReturnType<typeof createMockConsole> | undefined
let gateway: ReturnType<typeof createMockGateway> | undefined

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-autologin-"))
})

afterEach(async () => {
  await console_?.close()
  await gateway?.close()
  console_ = undefined
  gateway = undefined
  fs.rmSync(home, { recursive: true, force: true })
})

async function start(options: { auto?: "approve" | "deny" } = {}) {
  gateway = createMockGateway({ quiet: true })
  await gateway.ready
  console_ = createMockConsole({ quiet: true, interval: 1, auto: options.auto ?? "approve", autoAfter: 1, gatewayURL: gateway.url + "/v1" })
  await console_.ready
}

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
    RAFIKICODE_NO_DEFAULT_WORKSPACE: "1",
    RAFIKICODE_CONSOLE_URL: console_?.url,
    RAFIKICODE_GATEWAY_URL: gateway ? gateway.url + "/v1" : undefined,
    RAFIKICODE_TEST_TTY: "1",
  }
  for (const name of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "RAFIKICODE_API_KEY", "RAFIKICODE_NO_AUTO_LOGIN", "RAFIKICODE_TEST_AUTO_LOGIN", Brand.providers.testEnv])
    delete env[name]
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
const codeRequests = () => console_!.requests.filter((r: any) => r.path === "/api/v1/device/code")
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "")

describe("when the sign-in starts on its own", () => {
  const tty = { stdin: true, stdout: true }
  test("a terminal on stdin and stdout, outside CI, without --format json or the switch", () => {
    expect(autoSignIn({}, {}, tty)).toBe(true)
    expect(autoSignIn({ format: "default" }, {}, tty)).toBe(true)
    expect(autoSignIn({}, {}, { stdin: true, stdout: false })).toBe(false)
    expect(autoSignIn({}, {}, { stdin: false, stdout: true })).toBe(false)
    expect(autoSignIn({ format: "json" }, {}, tty)).toBe(false)
    expect(autoSignIn({}, { CI: "1" }, tty)).toBe(false)
    expect(autoSignIn({}, { RAFIKICODE_API_KEY: "sk-x" }, tty)).toBe(false)
    // The general test hook does not count as a terminal here.
    expect(autoSignIn({}, { RAFIKICODE_TEST_TTY: "1" }, { stdin: false, stdout: false })).toBe(false)
  })

  test("RAFIKICODE_NO_AUTO_LOGIN turns it off; 0 and false leave it on", () => {
    expect(autoSignIn({}, { RAFIKICODE_NO_AUTO_LOGIN: "1" }, tty)).toBe(false)
    expect(autoSignIn({}, { RAFIKICODE_NO_AUTO_LOGIN: "true" }, tty)).toBe(false)
    expect(autoSignIn({}, { RAFIKICODE_NO_AUTO_LOGIN: "0" }, tty)).toBe(true)
    expect(autoSignIn({}, { RAFIKICODE_NO_AUTO_LOGIN: "false" }, tty)).toBe(true)
  })
})

describe("the sign-in in place, against a stubbed device flow", () => {
  test("starts the device flow and stores the key; a refusal comes back with its reason", async () => {
    const calls: string[] = []
    const replies: Record<string, () => Response> = {
      "/api/v1/device/code": () =>
        Response.json({ device_code: "dc", user_code: "BCDF-GHJK", verification_uri: "https://console.test/device", interval: 1, expires_in: 600 }),
      "/api/v1/device/token": () => Response.json({ access_token: "sk-stub-auto", key_alias: "rafikicode-stub", owner: { id: "u1", email: "jane@example.com" } }),
    }
    const client = DeviceFlow.client({
      consoleURL: "https://console.test",
      sleep: async () => {},
      fetch: async (url) => {
        const route = new URL(url).pathname
        calls.push(route)
        return replies[route]!()
      },
    })
    const previous = process.env["XDG_CONFIG_HOME"]
    process.env["XDG_CONFIG_HOME"] = home
    try {
      expect(await signInHere(client)).toEqual({ ok: true })
      expect(calls).toEqual(["/api/v1/device/code", "/api/v1/device/token"])
      expect(JSON.parse(fs.readFileSync(path.join(Brand.configDir(), "credentials"), "utf8")).key).toBe("sk-stub-auto")

      replies["/api/v1/device/token"] = () => Response.json({ error: { code: "access_denied", type: "access_denied" } }, { status: 400 })
      const denied = await signInHere(client)
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.message).toBe("Sign-in was denied in the browser.")
    } finally {
      if (previous === undefined) delete process.env["XDG_CONFIG_HOME"]
      else process.env["XDG_CONFIG_HOME"] = previous
    }
  })
})

describe("rafikicode run with no key, against the mock Console and the mock gateway", () => {
  test("at a terminal: signs in, then the run carries on to the gateway", async () => {
    await start()
    const result = await run(["run", "say hello"], { RAFIKICODE_TEST_AUTO_LOGIN: "1" })
    const out = plain(result.all)
    expect(out).toContain("Not signed in. Starting sign-in.")
    expect(out).toContain(`${console_!.url}/device`)
    expect(out).toMatch(/[BCDFGHJKMNPQRSTVWXZ]{4}-[BCDFGHJKMNPQRSTVWXZ]{4}/)
    expect(out).toContain("Signed in as")
    expect(out).not.toContain("needs a Rafiki AI account")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Mock gateway reply")
    expect(codeRequests().length).toBe(1)
    expect(JSON.parse(fs.readFileSync(credentials(), "utf8")).key).toStartWith("sk-mock-")
  }, 120_000)

  test("at a terminal, a refused sign-in shows the reason and the old guidance", async () => {
    await start({ auto: "deny" })
    const result = await run(["run", "say hello"], { RAFIKICODE_TEST_AUTO_LOGIN: "1" })
    const out = plain(result.stderr)
    expect(out).toContain("Not signed in. Starting sign-in.")
    expect(out).toContain("Error: Sign-in was denied in the browser.")
    expect(out).toContain("Rafiki Code needs a Rafiki AI account.")
    expect(out).toContain("set RAFIKICODE_API_KEY.")
    expect(result.exitCode).not.toBe(0)
    expect(fs.existsSync(credentials())).toBe(false)
  }, 120_000)

  test("without a terminal: the exact old message and exit code, no sign-in", async () => {
    await start()
    const result = await run(["run", "say hello"])
    expect(result.exitCode).toBe(2)
    expect(plain(result.stderr).trim()).toBe(oldMessage(console_!.url))
    expect(result.stdout).toBe("")
    expect(codeRequests().length).toBe(0)
  }, 120_000)

  test("RAFIKICODE_NO_AUTO_LOGIN=1, --format json and CI keep the old message at a terminal", async () => {
    await start()
    for (const [args, extra] of [
      [["run", "say hello"], { RAFIKICODE_NO_AUTO_LOGIN: "1" }],
      [["run", "--format", "json", "say hello"], {}],
      [["run", "say hello"], { CI: "1" }],
    ] as const) {
      const result = await run([...args], { RAFIKICODE_TEST_AUTO_LOGIN: "1", ...extra })
      expect(result.exitCode).toBe(2)
      expect(plain(result.stderr).trim()).toBe(oldMessage(console_!.url))
    }
    expect(codeRequests().length).toBe(0)
  }, 180_000)
})

describe("rafikicode logout", () => {
  test("ends with how to sign in again", async () => {
    await start()
    const login = await run(["login", "--label", "auto login test"])
    expect(login.exitCode).toBe(0)
    const out = await run(["logout"])
    expect(out.exitCode).toBe(0)
    const lines = plain(out.all).trim().split("\n")
    expect(lines.at(-1)).toBe(signInAgain())
    expect(signInAgain()).toBe("To sign in again, run rafikicode login, or start rafikicode in a terminal.")
  }, 120_000)
})
