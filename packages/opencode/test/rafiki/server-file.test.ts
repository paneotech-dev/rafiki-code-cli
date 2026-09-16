// rafikicode serve and web on 127.0.0.1 without a password (UU finding 4):
// a random password per server, stored in <config dir>/servers/<port>.json
// (directory 0700, file 0600), read by attach and run --attach, removed on
// exit. A password the person set keeps the earlier behaviour.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as ServerFile from "../../src/rafiki/server-file"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const KEY = "sk-server-file-stub-0001"
const serverNames = ["RAFIKICODE_SERVER_PASSWORD", "RAFIKICODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME"]
const uid = process.getuid!()
const posix = process.platform !== "win32"

function mode(target: string) {
  return fs.statSync(target).mode & 0o777
}

function info(port: number, pid = process.pid): ServerFile.ServerFile {
  return { version: 1, port, pid, hostname: "127.0.0.1", username: "rafikicode", password: "stub-file-password-0001", created_at: new Date().toISOString() }
}

// A pid that is not running: a short child that has exited.
async function deadPid() {
  const child = Bun.spawn(["true"])
  await child.exited
  return child.pid
}

describe("server file", () => {
  let base: string
  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-server-file-"))
  })
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

  function fresh() {
    return path.join(fs.mkdtempSync(path.join(base, "cfg-")), ".rafikicode", ServerFile.DIR_NAME)
  }

  test.skipIf(!posix)("the directory is 0700 and the file 0600, even under umask 000 and an existing 0755 directory", () => {
    const directory = fresh()
    const saved = process.umask(0)
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o755 })
      fs.chmodSync(directory, 0o755)
      const target = ServerFile.write(info(4151), directory)
      expect(target).toBe(path.join(directory, "4151.json"))
      expect(mode(directory)).toBe(0o700)
      expect(mode(target)).toBe(0o600)
      expect(JSON.parse(fs.readFileSync(target, "utf8"))).toMatchObject({ version: 1, port: 4151, pid: process.pid, username: "rafikicode" })
      // Atomic write: no temp file is left behind.
      expect(fs.readdirSync(directory)).toEqual(["4151.json"])
    } finally {
      process.umask(saved)
    }
  })

  test.skipIf(!posix)("an unsafe directory is refused: a symbolic link, a parent others can write, another owner", () => {
    const linked = fresh()
    fs.mkdirSync(path.dirname(linked), { recursive: true })
    const elsewhere = fs.mkdtempSync(path.join(base, "elsewhere-"))
    fs.symlinkSync(elsewhere, linked)
    expect(() => ServerFile.write(info(4152), linked)).toThrow("is a symbolic link")
    expect(fs.readdirSync(elsewhere)).toEqual([])

    const open = fresh()
    fs.mkdirSync(path.dirname(open), { recursive: true })
    fs.chmodSync(path.dirname(open), 0o777)
    expect(() => ServerFile.write(info(4153), open)).toThrow("can be changed by other users")

    const theirs = fresh()
    expect(() => ServerFile.write(info(4154), theirs, uid + 1)).toThrow("belongs to another user")
  })

  test("a loopback URL finds the file of a live server; other addresses and ports do not", () => {
    const directory = fresh()
    ServerFile.write(info(4155), directory)
    for (const url of ["http://127.0.0.1:4155", "http://localhost:4155/", "http://[::1]:4155"]) {
      const found = ServerFile.lookup(url, { directory })
      expect(found.status, url).toBe("found")
      if (found.status === "found") expect(found.info.password).toBe("stub-file-password-0001")
    }
    for (const url of ["http://192.168.1.10:4155", "http://example.com:4155", "http://127.0.0.1:4156", "not a url"]) {
      expect(ServerFile.lookup(url, { directory }).status, url).toBe("none")
    }
  })

  test("a stale file (its process is gone) is ignored and removed", async () => {
    const directory = fresh()
    const pid = await deadPid()
    const target = ServerFile.write(info(4157, pid), directory)
    expect(ServerFile.lookup("http://127.0.0.1:4157", { directory })).toEqual({ status: "stale", file: target })
    expect(fs.existsSync(target)).toBe(false)

    // A live pid of another user is not this server either (the pid was reused).
    const reused = ServerFile.write(info(4158, 4242), directory)
    expect(ServerFile.lookup("http://127.0.0.1:4158", { directory, alive: () => false }).status).toBe("stale")
    expect(fs.existsSync(reused)).toBe(false)
    if (process.platform === "linux") {
      expect(ServerFile.liveProcessOf(process.pid)).toBe(true)
      expect(ServerFile.liveProcessOf(process.pid, uid + 1)).toBe(false)
      expect(ServerFile.liveProcessOf(await deadPid())).toBe(false)
    }
  })

  test.skipIf(!posix)("a file of another user, or one others can read, is rejected and kept", () => {
    const directory = fresh()
    const target = ServerFile.write(info(4159), directory)
    // Simulated ownership: the file and its directory belong to this uid, the reader is another.
    const other = ServerFile.lookup("http://127.0.0.1:4159", { directory, uid: uid + 1 })
    expect(other.status).toBe("rejected")
    if (other.status === "rejected") expect(other.reason).toContain("belongs to another user")
    expect(fs.existsSync(target)).toBe(true)

    fs.chmodSync(target, 0o644)
    const readable = ServerFile.lookup("http://127.0.0.1:4159", { directory })
    expect(readable).toMatchObject({ status: "rejected", reason: "can be read or written by other users (mode 0644)" })
    fs.chmodSync(target, 0o600)

    fs.chmodSync(directory, 0o755)
    expect(ServerFile.lookup("http://127.0.0.1:4159", { directory }).status).toBe("rejected")
    fs.chmodSync(directory, 0o700)

    const link = path.join(directory, "4160.json")
    fs.symlinkSync(target, link)
    expect(ServerFile.lookup("http://127.0.0.1:4160", { directory })).toMatchObject({ status: "rejected", reason: "is a symbolic link" })
    expect(ServerFile.lookup("http://127.0.0.1:4159", { directory }).status).toBe("found")
  })

  test.skipIf(!posix || uid !== 0)("as root: a file really owned by another user is rejected", () => {
    const directory = fresh()
    const target = ServerFile.write(info(4161), directory)
    fs.chownSync(target, 65534, 65534)
    const found = ServerFile.lookup("http://127.0.0.1:4161", { directory })
    expect(found).toMatchObject({ status: "rejected", reason: "belongs to another user (uid 65534)" })
    fs.chownSync(directory, 65534, 65534)
    fs.chownSync(target, 0, 0)
    expect(ServerFile.lookup("http://127.0.0.1:4161", { directory })).toMatchObject({ status: "rejected" })
    expect(() => ServerFile.write(info(4162), directory)).toThrow("belongs to another user (uid 65534)")
  })

  test("credentials: a given or environment password wins, else the file, and a rejected file is named", () => {
    const directory = fresh()
    ServerFile.write(info(4163), directory)
    const url = "http://127.0.0.1:4163"
    const warnings: string[] = []
    const warn = (line: string) => warnings.push(line)
    expect(ServerFile.credentials(url, { password: "given" }, {}, { directory }, warn)).toEqual({ password: "given" })
    expect(ServerFile.credentials(url, {}, { RAFIKICODE_SERVER_PASSWORD: "env" }, { directory }, warn)).toEqual({})
    expect(ServerFile.credentials(url, {}, { OPENCODE_SERVER_PASSWORD: "legacy" }, { directory }, warn)).toEqual({})
    expect(ServerFile.credentials(url, {}, {}, { directory }, warn)).toEqual({ password: "stub-file-password-0001", username: "rafikicode" })
    expect(ServerFile.credentials(url, { username: "me" }, {}, { directory }, warn)).toEqual({ password: "stub-file-password-0001", username: "me" })
    expect(ServerFile.credentials("http://10.0.0.1:4163", {}, {}, { directory }, warn)).toEqual({})
    expect(warnings).toEqual([])
    if (posix) {
      expect(ServerFile.credentials(url, {}, {}, { directory, uid: uid + 1 }, warn)).toEqual({})
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toContain(`not using the server file ${path.join(directory, "4163.json")}: it is in a directory that belongs to another user`)
      expect(warnings[0]).not.toContain("stub-file-password-0001")
    }
  })

  test("prepare: a loopback server without a password gets a random 32 byte one; a set one is kept; other addresses are refused", () => {
    const saved = { code: process.exitCode, home: process.env.OPENCODE_TEST_HOME, xdg: process.env.XDG_CONFIG_HOME }
    const lines: string[] = []
    const print = (line: string) => lines.push(line)
    try {
      process.env.OPENCODE_TEST_HOME = fs.mkdtempSync(path.join(base, "home-"))
      delete process.env.XDG_CONFIG_HOME
      const env: Record<string, string | undefined> = {}
      const first = ServerFile.prepare({ hostname: "127.0.0.1" }, env, print)!
      expect(first.generated).toBe(true)
      expect(Buffer.from(first.password, "base64url").length).toBe(32)
      expect(env.RAFIKICODE_SERVER_PASSWORD).toBe(first.password)
      const second = ServerFile.prepare({ hostname: "localhost" }, {}, print)!
      expect(second.password).not.toBe(first.password)
      if (posix) expect(mode(ServerFile.dir())).toBe(0o700)
      expect(ServerFile.dir()).toBe(path.join(process.env.OPENCODE_TEST_HOME, ".rafikicode", "servers"))
      ServerFile.forget(first, env)
      expect(env.RAFIKICODE_SERVER_PASSWORD).toBeUndefined()

      expect(ServerFile.prepare({ hostname: "127.0.0.1" }, { RAFIKICODE_SERVER_PASSWORD: "mine" }, print)).toEqual({ password: "mine", generated: false })
      expect(ServerFile.prepare({ hostname: "127.0.0.1" }, { OPENCODE_SERVER_PASSWORD: "legacy" }, print)).toEqual({ password: "legacy", generated: false })
      expect(ServerFile.prepare({ hostname: "0.0.0.0" }, { RAFIKICODE_SERVER_PASSWORD: "mine" }, print)).toEqual({ password: "mine", generated: false })
      expect(lines).toEqual([])
      const kept = { RAFIKICODE_SERVER_PASSWORD: "mine" }
      ServerFile.forget({ password: "mine", generated: false }, kept)
      expect(kept.RAFIKICODE_SERVER_PASSWORD).toBe("mine")

      // prepare() reads the process environment for the refusal, as serve does.
      const envSaved = serverNames.map((name) => [name, process.env[name]] as const)
      for (const name of serverNames) delete process.env[name]
      try {
        expect(ServerFile.prepare({ hostname: "0.0.0.0" }, {}, print)).toBeUndefined()
        expect(process.exitCode).toBe(2)
        expect(lines.join("\n")).toContain("Refusing to listen on 0.0.0.0 without a password")
      } finally {
        for (const [name, value] of envSaved) if (value !== undefined) process.env[name] = value
      }
    } finally {
      process.exitCode = saved.code ?? 0
      if (saved.home === undefined) delete process.env.OPENCODE_TEST_HOME
      else process.env.OPENCODE_TEST_HOME = saved.home
      if (saved.xdg !== undefined) process.env.XDG_CONFIG_HOME = saved.xdg
    }
  })

  test("remove only takes the file of the given process", () => {
    const directory = fresh()
    const target = ServerFile.write(info(4164, process.pid + 100000), directory)
    expect(ServerFile.remove(4164, process.pid, directory)).toBe(false)
    expect(fs.existsSync(target)).toBe(true)
    expect(ServerFile.remove(4164, process.pid + 100000, directory)).toBe(true)
    expect(fs.existsSync(target)).toBe(false)
  })

  test("the notice names the file and the user, never a password", () => {
    const line = ServerFile.notice("/home/u/.rafikicode/servers/4096.json", "rafikicode")
    expect(line).toBe(
      "Server password: stored in /home/u/.rafikicode/servers/4096.json (user name rafikicode). rafikicode attach and run --attach on this machine read it from there; other programs must send it. Set RAFIKICODE_SERVER_PASSWORD to choose your own.",
    )
  })
})

// A port in the project range that nothing listens on right now.
function freePort() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const port = 4140 + Math.floor(Math.random() * 60)
    try {
      Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true)
      return port
    } catch {}
  }
  throw new Error("no free port in 4140 to 4199")
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : entry.isFile() ? [full] : []
  })
}

describe("rafikicode serve and web without a password", () => {
  let home: string
  let gateway: ReturnType<typeof createMockGateway>

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-server-file-e2e-"))
    gateway = createMockGateway({ quiet: true, reply: "file-attached-answer" })
    await gateway.ready
  })

  afterAll(async () => {
    await gateway.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  function env(extra: Record<string, string | undefined> = {}) {
    const env: Record<string, string | undefined> = {
      ...process.env,
      COLUMNS: "120",
      PWD: home,
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      RAFIKICODE_GATEWAY_URL: gateway.url + "/v1",
      [Brand.env.apiKey]: KEY,
      BROWSER: "true",
      DISPLAY: "",
    }
    for (const k of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", Brand.providers.testEnv, ...serverNames]) delete env[k]
    Object.assign(env, extra)
    return env as Record<string, string>
  }

  const serversDir = () => path.join(home, ".rafikicode", "servers")

  async function start(command: "serve" | "web", extra: Record<string, string | undefined> = {}, flags: string[] = []) {
    const port = freePort()
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), command, "--port", String(port), ...flags], {
      cwd: home,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env(extra),
    })
    const out = { text: "" }
    const decoder = new TextDecoder()
    const drains = [proc.stdout, proc.stderr].map((stream) =>
      (async () => {
        for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) out.text += decoder.decode(chunk)
      })(),
    )
    const url = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 60_000
    let up = false
    while (!up && proc.exitCode === null && Date.now() < deadline) {
      up = await fetch(`${url}/global/health`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.status > 0, () => false)
      if (!up) await Bun.sleep(200)
    }
    if (!up) console.error(`${command} on ${port} did not answer (exit ${proc.exitCode}):\n${out.text}`)
    expect(up).toBe(true)
    // The notice follows the listen line.
    const noticeDeadline = Date.now() + 10_000
    while (!/Server password|listening on|Web interface/.test(out.text) && Date.now() < noticeDeadline) await Bun.sleep(100)
    await Bun.sleep(300)
    return {
      port,
      url,
      proc,
      out,
      file: path.join(serversDir(), `${port}.json`),
      stop: async (signal: NodeJS.Signals = "SIGTERM") => {
        proc.kill(signal)
        const timer = setTimeout(() => proc.kill(9), 15_000)
        const code = await proc.exited
        clearTimeout(timer)
        await Promise.all(drains)
        return code
      },
    }
  }

  async function run(args: string[], extra: Record<string, string | undefined> = {}) {
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "run", "--model", "rafiki/rafiki-fast", ...args], {
      cwd: home,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env(extra),
    })
    const timer = setTimeout(() => proc.kill(9), 90_000)
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    clearTimeout(timer)
    if (exitCode !== 0) console.error(`run ${args.join(" ")}: exit ${exitCode}\n${stdout}\n${stderr}`)
    return { exitCode, stdout, stderr }
  }

  const basic = (password: string, user = "rafikicode") => ({ authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` })

  test("serve: the file is 0600 in a 0700 directory, the password is never logged, routes need it, attach uses it, exit removes it", async () => {
    const server = await start("serve", {}, ["--print-logs", "--log-level", "DEBUG"])
    let stopped = false
    try {
      expect(fs.existsSync(server.file)).toBe(true)
      if (posix) {
        expect(mode(serversDir())).toBe(0o700)
        expect(mode(server.file)).toBe(0o600)
      }
      const stored = JSON.parse(fs.readFileSync(server.file, "utf8")) as ServerFile.ServerFile
      expect(stored).toMatchObject({ version: 1, port: server.port, pid: server.proc.pid, username: "rafikicode" })
      expect(stored.password.length).toBeGreaterThanOrEqual(43)

      expect(server.out.text).toContain(`Server password: stored in ${server.file} (user name rafikicode).`)
      expect(server.out.text).not.toContain("has no password")

      // Without the password: the file and terminal routes answer 401.
      const directory = { "x-opencode-directory": home }
      fs.mkdirSync(path.join(home, ".rafikicode"), { recursive: true })
      const probe = path.join(home, ".rafikicode", "probe-secret")
      fs.writeFileSync(probe, "probe-secret-0001", { mode: 0o600 })
      const read = await fetch(`${server.url}/file/content?path=${encodeURIComponent(".rafikicode/probe-secret")}`, { headers: directory })
      expect(read.status).toBe(401)
      expect(await read.text()).not.toContain("probe-secret-0001")
      const marker = path.join(home, "pty-ran")
      const pty = await fetch(`${server.url}/pty`, {
        method: "POST",
        headers: { ...directory, "content-type": "application/json" },
        body: JSON.stringify({ command: "/bin/sh", args: ["-c", `touch ${marker}`] }),
      })
      expect(pty.status).toBe(401)
      expect((await fetch(`${server.url}/path`)).status).toBe(401)
      expect((await fetch(`${server.url}/path`, { headers: basic("wrong-password") })).status).toBe(401)
      const withPassword = await fetch(`${server.url}/file/content?path=${encodeURIComponent(".rafikicode/probe-secret")}`, {
        headers: { ...directory, ...basic(stored.password) },
      })
      expect(withPassword.status).toBe(200)
      expect(await withPassword.text()).toContain("probe-secret-0001")
      await Bun.sleep(500)
      expect(fs.existsSync(marker)).toBe(false)

      // The generated password is not left in the server's environment for its children.
      if (process.platform === "linux") {
        expect(fs.readFileSync(`/proc/${server.proc.pid}/environ`, "utf8")).not.toContain(stored.password)
      }

      // run --attach with no password reads the file.
      const attached = await run(["--attach", server.url, "say it"])
      expect(attached.exitCode).toBe(0)
      expect(attached.stdout).toContain("file-attached-answer")
      expect(attached.stdout + attached.stderr).not.toContain(stored.password)

      // A wrong explicit password is not replaced by the file.
      const wrong = await run(["--attach", server.url, "--password", "not-the-password", "say it"])
      expect(wrong.exitCode).toBe(2)
      expect(wrong.stderr).toContain("refused the password")

      const code = await server.stop("SIGTERM")
      stopped = true
      expect(code).toBe(143)
      expect(fs.existsSync(server.file)).toBe(false)

      // The password never reached the output or the log files.
      expect(server.out.text).not.toContain(stored.password)
      const logs = walk(path.join(home, ".local")).concat(walk(path.join(home, ".cache")))
      for (const log of logs) expect(fs.readFileSync(log).includes(stored.password), log).toBe(false)
    } finally {
      if (!stopped) await server.stop()
    }
  }, 240_000)

  test("a stale file for the port is ignored and cleaned; nothing listening still exits 4", async () => {
    const port = freePort()
    fs.mkdirSync(serversDir(), { recursive: true, mode: 0o700 })
    const target = ServerFile.write({ ...info(port, await deadPid()) }, serversDir())
    const result = await run(["--attach", `http://127.0.0.1:${port}`, "say it"])
    expect(result.exitCode).toBe(4)
    expect(fs.existsSync(target)).toBe(false)
  }, 90_000)

  test("web: a file is written and removed on Ctrl-c, routes need the password", async () => {
    const server = await start("web")
    let stopped = false
    try {
      expect(fs.existsSync(server.file)).toBe(true)
      if (posix) expect(mode(server.file)).toBe(0o600)
      const stored = JSON.parse(fs.readFileSync(server.file, "utf8")) as ServerFile.ServerFile
      expect(server.out.text).toContain(`Server password: stored in ${server.file}`)
      expect(server.out.text).not.toContain(stored.password)
      const page = await fetch(`${server.url}/`)
      expect(page.status).toBe(401)
      expect(page.headers.get("www-authenticate")).toContain("Basic")
      expect((await fetch(`${server.url}/pty`, { method: "POST", headers: { "content-type": "application/json", "x-opencode-directory": home }, body: "{}" })).status).toBe(401)
      expect((await fetch(`${server.url}/path`, { headers: basic(stored.password) })).status).toBe(200)
      const code = await server.stop("SIGINT")
      stopped = true
      expect(code).toBe(130)
      expect(fs.existsSync(server.file)).toBe(false)
      expect(server.out.text).not.toContain(stored.password)
    } finally {
      if (!stopped) await server.stop()
    }
  }, 180_000)

  test("an explicit password keeps the earlier behaviour: no file, no warning, the password is required", async () => {
    for (const name of ["RAFIKICODE_SERVER_PASSWORD", "OPENCODE_SERVER_PASSWORD"]) {
      const server = await start("serve", { [name]: "explicit-password-0001" })
      try {
        expect(fs.existsSync(server.file)).toBe(false)
        expect(server.out.text).not.toContain("Server password")
        expect(server.out.text).not.toContain("has no password")
        expect((await fetch(`${server.url}/path`)).status).toBe(401)
        expect((await fetch(`${server.url}/path`, { headers: basic("explicit-password-0001") })).status).toBe(200)
        const missing = await run(["--attach", server.url, "say it"])
        expect(missing.exitCode).toBe(2)
        expect(missing.stderr).toContain("needs a password")
      } finally {
        await server.stop()
      }
    }
  }, 240_000)
})
