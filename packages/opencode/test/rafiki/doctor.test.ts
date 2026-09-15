// rafikicode doctor: every check against the mock gateway and mock Console,
// in process through Doctor.run and once as a subprocess for the exit codes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Credentials from "@opencode-ai/core/brand/credentials"
import * as Doctor from "../../src/rafiki/doctor"
import { createMockConsole } from "../brand/mock-console.mjs"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const upstreamWord = /(?<![A-Z_])opencode(?![A-Z_])/i

let home: string
let dir: string
let gateway: ReturnType<typeof createMockGateway> | undefined
let console_: ReturnType<typeof createMockConsole> | undefined

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-doctor-"))
  dir = path.join(home, ".rafikicode")
})

afterEach(async () => {
  await gateway?.close()
  await console_?.close()
  gateway = undefined
  console_ = undefined
  fs.rmSync(home, { recursive: true, force: true })
})

async function start() {
  gateway = createMockGateway({ quiet: true })
  await gateway.ready
  console_ = createMockConsole({ quiet: true, gatewayURL: gateway.url + "/v1" })
  await console_.ready
}

// A stored session credential the mock Console recognises, registered at the
// mock gateway with the given tiers and budget.
async function signIn(models = ["rafiki-fast", "rafiki-pro", "rafiki-max"], maxBudget: number | null = 2.5) {
  const minted = (console_ as any).approve
  // Mint through the device flow the mock exposes for tests.
  const code = await fetch(console_!.url + "/api/v1/device/code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: "rafikicode", surface: "cli", device_label: "doctor test" }),
  }).then((r) => r.json())
  expect(minted(code.user_code)).toBe(true)
  const token = await fetch(console_!.url + "/api/v1/device/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: code.device_code, client_id: "rafikicode" }),
  }).then((r) => r.json())
  expect(token.access_token).toStartWith("sk-mock-")
  Credentials.write(dir, {
    version: 1,
    key: token.access_token,
    key_id: token.key_id,
    key_alias: token.key_alias,
    kind: "session",
    gateway_url: gateway!.url + "/v1",
    console_url: console_!.url,
    owner: token.owner,
    expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
    created_at: new Date().toISOString(),
  })
  const registered = await fetch(gateway!.url + "/__test/register", {
    method: "POST",
    body: JSON.stringify({ key: token.access_token, key_alias: token.key_alias, models, max_budget: maxBudget }),
  })
  expect(registered.status).toBe(200)
  return token as { access_token: string; key_alias: string }
}

function options(extra: Partial<Doctor.Options> = {}): Doctor.Options {
  return {
    env: {},
    configDir: dir,
    gatewayURL: gateway!.url + "/v1",
    consoleURL: console_!.url,
    timeoutMs: 3000,
    execPath: "/home/someone/.rafikicode/bin/rafikicode",
    version: "1.2.3",
    channel: "latest",
    ...extra,
  }
}

const byName = (report: Doctor.Report, name: string) => report.lines.find((l) => l.name === name)!

describe("doctor checks", () => {
  test("everything ok with a stored sign-in and a valid config", async () => {
    await start()
    const token = await signIn()
    fs.writeFileSync(path.join(dir, "config.json"), '{\n  // a comment is fine\n  "model": "rafiki/rafiki-pro",\n}\n')

    const report = await Doctor.run(options())
    expect(report.lines.map((l) => l.name)).toEqual([...Doctor.NAMES])
    expect(report.ok).toBe(true)
    expect(report.failed).toBe(0)
    expect(byName(report, "config").detail).toContain("model rafiki/rafiki-pro")
    expect(byName(report, "credential").detail).toContain("stored session sign-in")
    expect(byName(report, "credential").detail).toContain(token.key_alias)
    expect(byName(report, "gateway").detail).toMatch(/answered in \d+ ms/)
    expect(byName(report, "key").detail).toBe(`key ${token.key_alias}, spent 0 USD of 2.5 USD budget, no expiry`)
    expect(byName(report, "tiers").detail).toBe("rafiki-fast, rafiki-pro, rafiki-max")
    expect(byName(report, "console").detail).toContain("account Jane jane@example.com")
    expect(byName(report, "console").detail).toContain("wallet 12.4 USD available")
    expect(byName(report, "version").detail).toBe("rafikicode 1.2.3, latest channel, installed by the installer script, rafikicode update applies")
    const text = report.lines.map(Doctor.format).join("\n")
    expect(text).not.toContain(token.access_token)
    expect(text).not.toMatch(upstreamWord)
    expect(gateway!.requests.find((r: any) => r.path === "/health/liveliness")).toBeTruthy()
    expect(gateway!.requests.find((r: any) => r.path === "/key/info")).toMatchObject({ key_alias: token.key_alias, status: 200 })
  })

  test("no credential: the dependent checks are skipped and the Console is still probed", async () => {
    await start()
    const report = await Doctor.run(options())
    expect(report.ok).toBe(false)
    expect(report.failed).toBe(1)
    expect(byName(report, "config").status).toBe("ok")
    expect(byName(report, "config").detail).toContain("not created yet")
    expect(byName(report, "credential")).toMatchObject({ status: "fail", detail: "none" })
    expect(byName(report, "credential").fix).toContain("rafikicode login")
    expect(byName(report, "credential").fix).toContain("RAFIKICODE_API_KEY")
    expect(byName(report, "key").status).toBe("skip")
    expect(byName(report, "tiers").status).toBe("skip")
    expect(byName(report, "console")).toMatchObject({ status: "ok", detail: `${console_!.url} reachable, not signed in` })
  })

  test("a server key from the environment wins and its tier list is reported", async () => {
    await start()
    const registered = await fetch(gateway!.url + "/__test/register", {
      method: "POST",
      body: JSON.stringify({ key: "sk-server-stub", key_alias: "ci-key", models: ["rafiki-fast"], max_budget: 10 }),
    })
    expect(registered.status).toBe(200)
    const report = await Doctor.run(options({ env: { RAFIKICODE_API_KEY: "sk-server-stub", CI: "1" } }))
    expect(byName(report, "credential")).toMatchObject({ status: "ok", detail: "RAFIKICODE_API_KEY from the environment" })
    expect(byName(report, "key")).toMatchObject({ status: "ok" })
    expect(byName(report, "tiers")).toMatchObject({ status: "ok", detail: "rafiki-fast (not on this key: rafiki-pro, rafiki-max)" })
    // The mock Console does not know a key minted at the gateway, which the gateway
    // accepts: a warning that it is not registered, not a revoked key, and doctor passes.
    expect(byName(report, "console")).toMatchObject({ status: "warn" })
    expect(byName(report, "console").detail).toContain("does not know this key (401)")
    expect(byName(report, "console").fix).toContain("This key is valid at the gateway but not registered in Rafiki Console (created outside the Console)")
    expect(byName(report, "console").fix).toContain("rafikicode login")
    expect(byName(report, "console").fix).not.toContain("revoked")
    expect(byName(report, "console").note).toBe(
      `Usage still works and is metered at the gateway. Console features such as the wallet view and key management do not apply to this key; create a key at ${console_!.url}/keys to get them.`,
    )
    expect(byName(report, "console").network).toBeUndefined()
    expect(report).toMatchObject({ ok: true, failed: 0, warned: 1, exitCode: 0 })
    expect(JSON.stringify(report)).not.toContain("sk-server-stub")
  })

  test("a key the gateway rejects stays a failure at the Console, not a warning", async () => {
    await start()
    const report = await Doctor.run(options({ env: { RAFIKICODE_API_KEY: "sk-unknown-stub" } }))
    expect(byName(report, "key")).toMatchObject({ status: "fail", detail: "rejected by the gateway (401)" })
    expect(byName(report, "console")).toMatchObject({
      status: "fail",
      detail: `${console_!.url} does not accept this key (401)`,
      fix: "This key was revoked or has expired. Run rafikicode login.",
    })
    expect(report).toMatchObject({ ok: false, failed: 2, warned: 0, exitCode: 1 })
  })

  test("a key revoked at the Console and the gateway fails both lines and exits 1", async () => {
    await start()
    const token = await signIn()
    const stored = Credentials.read(dir)!
    const revoked = await fetch(`${console_!.url}/api/v1/keys/${stored.key_id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token.access_token}` },
    })
    expect(revoked.status).toBe(200)
    await fetch(gateway!.url + "/key/delete", {
      method: "POST",
      headers: { authorization: "Bearer sk-master-mock" },
      body: JSON.stringify({ key_aliases: [token.key_alias] }),
    })
    const report = await Doctor.run(options())
    expect(byName(report, "key")).toMatchObject({ status: "fail", detail: "rejected by the gateway (401)" })
    expect(byName(report, "console")).toMatchObject({
      status: "fail",
      detail: `${console_!.url} does not accept this key (401)`,
      fix: "This key was revoked or has expired. Run rafikicode login.",
    })
    expect(report).toMatchObject({ ok: false, warned: 0, exitCode: 1 })
  })

  test("a stored sign-in is refused when CI is set", async () => {
    await start()
    await signIn()
    const report = await Doctor.run(options({ env: { CI: "true" } }))
    expect(byName(report, "credential")).toMatchObject({ status: "fail" })
    expect(byName(report, "credential").detail).toContain("CI is set")
    expect(byName(report, "credential").fix).toContain(`${console_!.url}/keys`)
    expect(byName(report, "key").status).toBe("skip")
  })

  test("invalid config is named with its line, and a non object is refused", async () => {
    await start()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "config.json"), '{\n  "model": "rafiki/rafiki-fast"\n  "oops": true\n}\n')
    expect(Doctor.checkConfig(dir)).toMatchObject({ status: "fail" })
    expect(Doctor.checkConfig(dir).detail).toMatch(/not valid JSON \(.+ at line 3\)/)
    fs.writeFileSync(path.join(dir, "config.json"), "[1, 2]\n")
    expect(Doctor.checkConfig(dir).detail).toContain("does not contain a JSON object")
    fs.writeFileSync(path.join(dir, "config.json"), '{ "model": "openai/gpt-x" }\n')
    const other = Doctor.checkConfig(dir)
    expect(other.status).toBe("ok")
    expect(other.detail).toContain("not metered by the wallet")
  })

  test("a revoked key, a spent budget, and a key without tiers each fail with the Console link", async () => {
    await start()
    const token = await signIn(["rafiki-fast", "rafiki-pro"], 1)
    const keysPage = `${console_!.url}/keys`

    await fetch(gateway!.url + "/__test/spend", { method: "POST", body: JSON.stringify({ key_alias: token.key_alias, spend: 1 }) })
    const spent = await Doctor.run(options())
    expect(byName(spent, "key")).toMatchObject({ status: "fail" })
    expect(byName(spent, "key").detail).toBe(`key ${token.key_alias} has used its budget, 1 of 1 USD`)
    expect(byName(spent, "key").fix).toBe(`Top up or raise the key's budget at ${keysPage}.`)
    expect(byName(spent, "tiers")).toMatchObject({ status: "skip", detail: "key check failed" })

    await fetch(gateway!.url + "/__test/spend", { method: "POST", body: JSON.stringify({ key_alias: token.key_alias, spend: 0.25 }) })
    const partial = await Doctor.run(options())
    expect(byName(partial, "key").detail).toBe(`key ${token.key_alias}, spent 0.25 USD of 1 USD budget, no expiry`)
    expect(byName(partial, "tiers").detail).toBe("rafiki-fast, rafiki-pro (not on this key: rafiki-max)")

    const deleted = await fetch(gateway!.url + "/key/delete", {
      method: "POST",
      headers: { authorization: "Bearer sk-master-mock" },
      body: JSON.stringify({ key_aliases: [token.key_alias] }),
    })
    expect((await deleted.json()).deleted_keys).toEqual([token.key_alias])
    const revoked = await Doctor.run(options())
    expect(byName(revoked, "key")).toMatchObject({ status: "fail", detail: "rejected by the gateway (401)" })
    expect(byName(revoked, "key").fix).toContain("rafikicode login")
    expect(byName(revoked, "key").fix).toContain(keysPage)

    const none = await Doctor.checkTiers(gateway!.url, "sk-none", { models: ["some-other-model"] }, console_!.url, fetch, 3000)
    expect(none).toMatchObject({ status: "fail" })
    expect(none.detail).toContain("none of rafiki-fast, rafiki-pro, rafiki-max")
    expect(none.fix).toContain(keysPage)
  })

  test("an empty model list on the key falls back to the gateway's model list", async () => {
    await start()
    const line = await Doctor.checkTiers(gateway!.url, "sk-any", { models: [] }, console_!.url, fetch, 3000)
    expect(line).toMatchObject({ status: "ok", detail: "rafiki-fast, rafiki-pro, rafiki-max" })
    expect(gateway!.requests.find((r: any) => r.path === "/v1/models")).toBeTruthy()
  })

  test("an unreachable gateway and Console are reported with the override hint", async () => {
    const report = await Doctor.run({
      env: { RAFIKICODE_GATEWAY_URL: "set", RAFIKICODE_CONSOLE_URL: "set" },
      configDir: dir,
      gatewayURL: "http://127.0.0.1:1/v1",
      consoleURL: "http://127.0.0.1:1",
      timeoutMs: 2000,
    })
    expect(byName(report, "gateway")).toMatchObject({ status: "fail" })
    expect(byName(report, "gateway").detail).toStartWith("http://127.0.0.1:1 unreachable (")
    expect(byName(report, "gateway").fix).toBe("Check the network, and RAFIKICODE_GATEWAY_URL which is set.")
    expect(byName(report, "console").fix).toBe("Check the network, and RAFIKICODE_CONSOLE_URL which is set.")
    expect(report.failed).toBe(3)
    expect(report.exitCode).toBe(4)
  })

  test("with a key, an unreachable gateway skips the key and tier checks instead of waiting on them", async () => {
    // A routable address nobody answers on would wait the whole timeout per
    // check; a counting fetch that never resolves stands in for it.
    let calls = 0
    const hang: typeof fetch = ((url: string, init?: RequestInit) => {
      calls++
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timed out"))))
    }) as typeof fetch
    const started = Date.now()
    const report = await Doctor.run({
      env: { RAFIKICODE_API_KEY: "sk-doctor-hang-stub" },
      configDir: dir,
      gatewayURL: "http://10.255.255.1:4197/v1",
      consoleURL: "http://127.0.0.1:1",
      fetch: hang,
      timeoutMs: 700,
    })
    expect(byName(report, "gateway")).toMatchObject({ status: "fail", network: true })
    expect(byName(report, "key")).toMatchObject({ status: "skip", detail: "gateway unreachable" })
    expect(byName(report, "tiers")).toMatchObject({ status: "skip", detail: "gateway unreachable" })
    expect(report.exitCode).toBe(4)
    // gateway and console only: two timeouts, not three.
    expect(calls).toBe(2)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test("an unhealthy gateway and a Console outage fail without blaming the key", async () => {
    gateway = createMockGateway({ quiet: true, fail: "down" })
    await gateway.ready
    console_ = createMockConsole({ quiet: true })
    await console_.ready
    const line = await Doctor.checkGateway(gateway.url, fetch, 3000, {}, Date.now)
    expect(line).toMatchObject({ status: "fail", fix: "The gateway is up but not healthy. Try again shortly." })
    expect(line.detail).toBe(`${gateway.url}/health/liveliness answered 503`)
  })

  test("a Console that redirects the account route is reachable, not an account", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("", { status: 307, headers: { location: "/login" } }),
    })
    try {
      const url = `http://127.0.0.1:${server.port}`
      const line = await Doctor.checkConsole(url, "sk-any", {}, fetch, 3000)
      expect(line).toMatchObject({ status: "ok", detail: `${url} reachable, account route not available (307)` })
      expect(JSON.stringify(line)).not.toContain("sk-any")
    } finally {
      server.stop(true)
    }
  })

  test("helpers: gateway root, money, install method, expired credential", () => {
    expect(Doctor.gatewayRoot("https://gateway.rafikiai.io/v1")).toBe("https://gateway.rafikiai.io")
    expect(Doctor.gatewayRoot("http://127.0.0.1:4180/v1/")).toBe("http://127.0.0.1:4180")
    expect(Doctor.gatewayRoot("http://127.0.0.1:4180")).toBe("http://127.0.0.1:4180")
    expect(Doctor.money(0.31)).toBe("0.31")
    expect(Doctor.money(2.5)).toBe("2.5")
    expect(Doctor.money(0)).toBe("0")
    expect(Doctor.money(0.000049)).toBe("0")
    expect(Doctor.money("x")).toBe("?")
    expect(Doctor.installMethod("/home/u/.rafikicode/bin/rafikicode", "latest")).toContain("rafikicode update applies")
    expect(Doctor.installMethod("C:\\Users\\u\\.rafikicode\\bin\\rafikicode.exe", "latest")).toContain("rafikicode update applies")
    expect(Doctor.installMethod("/usr/lib/node_modules/rafikicode/bin/rafikicode", "latest")).toContain("npm install -g rafikicode@latest")
    expect(Doctor.installMethod("/usr/bin/bun", "local")).toBe("running from a source checkout")
    expect(Doctor.installMethod("/opt/rafikicode", "latest")).toContain("installed elsewhere")

    Credentials.write(dir, {
      version: 1,
      key: "sk-old",
      key_alias: "old",
      kind: "session",
      gateway_url: "http://127.0.0.1:1/v1",
      console_url: "http://127.0.0.1:1",
      expires_at: "2020-01-01T00:00:00.000Z",
      created_at: "2019-12-01T00:00:00.000Z",
    })
    const expired = Doctor.checkCredential({}, dir, "http://127.0.0.1:1", Date.now())
    expect(expired.line).toMatchObject({ status: "fail", fix: "Run rafikicode login." })
    expect(expired.line.detail).toContain("expired on 2020-01-01")
    expect(expired.key).toBeUndefined()
    expect(JSON.stringify(expired.line)).not.toContain("sk-old")
  })

  test("an unsafe credential file fails the credential check with its fix; the env key still passes", () => {
    Credentials.write(dir, {
      version: 1,
      key: "sk-loose",
      gateway_url: "http://127.0.0.1:1/v1",
      console_url: "http://127.0.0.1:1",
      created_at: new Date().toISOString(),
    })
    fs.chmodSync(Credentials.file(dir), 0o644)
    const refused = Doctor.checkCredential({}, dir, "http://127.0.0.1:1", Date.now())
    expect(refused.line.status).toBe("fail")
    expect(refused.line.detail).toContain("refused: the file can be read or written by other users (mode 0644)")
    expect(refused.line.fix).toContain(`chmod 600 ${Credentials.file(dir)}`)
    expect(refused.key).toBeUndefined()
    expect(JSON.stringify(refused.line)).not.toContain("sk-loose")

    const env = Doctor.checkCredential({ RAFIKICODE_API_KEY: "sk-env" }, dir, "http://127.0.0.1:1", Date.now())
    expect(env.line.status).toBe("ok")
    expect(env.line.detail).toContain("is not used because the file can be read or written by other users")
    expect(env.source).toBe("environment")
  })
})

describe("rafikicode doctor as a subprocess", () => {
  async function run(extra: Record<string, string | undefined> = {}, args = ["doctor", "--timeout", "3"]) {
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
    // Colors off: the assertions read the plain columns.
    const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "")
    return { exitCode, stdout, stderr, all: plain(stdout + stderr) }
  }

  test("exit 0 with a stored sign-in, exit 1 without, key never printed", async () => {
    await start()
    const token = await signIn()
    const good = await run()
    expect(good.exitCode).toBe(0)
    expect(good.all).toContain("All checks passed.")
    expect(good.all).toContain(`ok    key         key ${token.key_alias}, spent 0 USD of 2.5 USD budget`)
    expect(good.all).toContain("ok    tiers       rafiki-fast, rafiki-pro, rafiki-max")
    expect(good.all).toContain("ok    version     rafikicode ")
    expect(good.all).not.toContain(token.access_token)
    expect(good.all).not.toMatch(upstreamWord)

    Credentials.remove(dir)
    const bad = await run()
    expect(bad.exitCode).toBe(1)
    expect(bad.all).toContain("FAIL  credential  none. Fix: Run rafikicode login, or set RAFIKICODE_API_KEY on servers and in CI.")
    expect(bad.all).toContain("skip  key         no credential to check")
    expect(bad.all).toContain("1 check needs attention")
  }, 120_000)

  test("an environment key that the gateway rejects exits 1 with the key hint", async () => {
    await start()
    const result = await run({ RAFIKICODE_API_KEY: "sk-unknown-stub", CI: "1" })
    expect(result.exitCode).toBe(1)
    expect(result.all).toContain("ok    credential  RAFIKICODE_API_KEY from the environment")
    expect(result.all).toContain("FAIL  key         rejected by the gateway (401)")
    expect(result.all).not.toContain("sk-unknown-stub")
  }, 120_000)

  test("a key the gateway accepts but the Console does not know: doctor warns and exits 0, whoami exits 2", async () => {
    await start()
    const registered = await fetch(gateway!.url + "/__test/register", {
      method: "POST",
      body: JSON.stringify({ key: "sk-gateway-only-stub", key_alias: "gw-key", models: ["rafiki-fast", "rafiki-pro", "rafiki-max"], max_budget: 5 }),
    })
    expect(registered.status).toBe(200)
    const keys = `${console_!.url}/keys`
    const explanation = `This key is valid at the gateway but not registered in Rafiki Console (created outside the Console). Create a key at ${keys}, or run rafikicode login.`
    const meaning = `Usage still works and is metered at the gateway. Console features such as the wallet view and key management do not apply to this key; create a key at ${keys} to get them.`

    const doctor = await run({ RAFIKICODE_API_KEY: "sk-gateway-only-stub", CI: "1" })
    expect(doctor.exitCode).toBe(0)
    expect(doctor.all).toContain("ok    key         key gw-key, spent 0 USD of 5 USD budget")
    expect(doctor.all).toContain(`WARN  console     ${console_!.url} does not know this key (401). Fix: ${explanation}\n                  ${meaning}`)
    expect(doctor.all).toContain("All checks passed, 1 warning, see the line marked WARN.")
    expect(doctor.all).not.toContain("FAIL")
    expect(doctor.all).not.toContain("sk-gateway-only-stub")

    const whoami = await run({ RAFIKICODE_API_KEY: "sk-gateway-only-stub", CI: "1" }, ["whoami"])
    expect(whoami.exitCode).toBe(2)
    expect(whoami.all).toContain(explanation)
    expect(whoami.all).toContain(meaning)
    expect(whoami.all).not.toContain("revoked")
    expect(whoami.all).not.toContain("sk-gateway-only-stub")
  }, 120_000)
})

describe("a Console 401", () => {
  const unauthorized = (async () =>
    new Response("{}", { status: 401, headers: { "content-type": "application/json" } })) as unknown as typeof fetch

  test("names a revoked key only when the gateway refuses it too, and warns otherwise", async () => {
    const refused = await Doctor.checkConsole("https://console.example", "sk-stub", {}, unauthorized, 1_000)
    expect(refused).toMatchObject({ status: "fail", fix: "This key was revoked or has expired. Run rafikicode login." })
    expect(refused.note).toBeUndefined()
    const unknown = await Doctor.checkConsole("https://console.example", "sk-stub", {}, unauthorized, 1_000, true)
    expect(unknown.status).toBe("warn")
    expect(unknown.detail).toBe("https://console.example does not know this key (401)")
    expect(unknown.fix).toContain("This key is valid at the gateway but not registered in Rafiki Console (created outside the Console)")
    expect(unknown.fix).toContain("https://console.example/keys")
    expect(unknown.note).toBe(Doctor.notRegisteredMeaning("https://console.example"))
    expect(unknown.note).toContain("Usage still works and is metered at the gateway")
    expect(unknown.note).toContain("wallet view and key management do not apply to this key")
    expect(Doctor.format(unknown)).toBe(
      "WARN  console     https://console.example does not know this key (401). Fix: " +
        Doctor.notRegistered("https://console.example") +
        "\n                  " +
        Doctor.notRegisteredMeaning("https://console.example"),
    )
  })

  test("a Console network error stays a network failure even when the gateway accepts the key", async () => {
    const down = (async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } })
    }) as unknown as typeof fetch
    const line = await Doctor.checkConsole("https://console.example", "sk-stub", {}, down, 1_000, true)
    expect(line).toMatchObject({ status: "fail", network: true, detail: "https://console.example unreachable (ECONNREFUSED)" })
    expect(line.note).toBeUndefined()
  })

  test("a Console 5xx stays a failure even when the gateway accepts the key", async () => {
    for (const status of [500, 502, 503]) {
      const broken = (async () => new Response("{}", { status })) as unknown as typeof fetch
      const line = await Doctor.checkConsole("https://console.example", "sk-stub", {}, broken, 1_000, true)
      expect(line).toMatchObject({
        status: "fail",
        detail: `https://console.example answered ${status}`,
        fix: "The Console is having trouble. Try again shortly.",
      })
    }
  })

  test("a warning does not fail the report; a Console outage beside it still does", async () => {
    const gatewayOK = (async (url: string) => {
      if (url.endsWith("/health/liveliness")) return new Response("{}", { status: 200 })
      if (url.endsWith("/key/info")) return Response.json({ info: { key_alias: "gw-key", spend: 0, max_budget: 5, models: ["rafiki-fast"] } })
      return new Response("", { status: 404 })
    }) as (url: string) => Promise<Response>
    const run = (consoleStatus: number | "down") =>
      Doctor.run({
        env: { RAFIKICODE_API_KEY: "sk-gateway-only-stub" },
        configDir: dir,
        gatewayURL: "https://gateway.example/v1",
        consoleURL: "https://console.example",
        timeoutMs: 1_000,
        fetch: (async (url: string) => {
          if (url.startsWith("https://console.example")) {
            if (consoleStatus === "down") throw new Error("fetch failed")
            return new Response("{}", { status: consoleStatus })
          }
          return gatewayOK(url)
        }) as unknown as typeof fetch,
      })
    const warned = await run(401)
    expect(byName(warned, "console").status).toBe("warn")
    expect(warned).toMatchObject({ ok: true, failed: 0, warned: 1, exitCode: 0 })
    const outage = await run(503)
    expect(byName(outage, "console").status).toBe("fail")
    expect(outage).toMatchObject({ ok: false, failed: 1, warned: 0, exitCode: 1 })
    const offline = await run("down")
    expect(byName(offline, "console")).toMatchObject({ status: "fail", network: true })
    expect(offline).toMatchObject({ ok: false, failed: 1, warned: 0, exitCode: 4 })
    expect(JSON.stringify([warned, outage, offline])).not.toContain("sk-gateway-only-stub")
  })

  test("the gateway accepts a key it describes and that has not expired", () => {
    const line = { name: "key", status: "ok", detail: "" } as any
    const now = Date.parse("2026-09-15T00:00:00Z")
    expect(Doctor.gatewayAccepts({ line }, now)).toBe(false)
    expect(Doctor.gatewayAccepts({ line, info: {} }, now)).toBe(true)
    expect(Doctor.gatewayAccepts({ line, info: { expires: "2030-01-01T00:00:00Z" } }, now)).toBe(true)
    expect(Doctor.gatewayAccepts({ line, info: { expires: "2026-01-01T00:00:00Z" } }, now)).toBe(false)
  })
})
