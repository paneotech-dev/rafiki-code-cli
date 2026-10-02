// Automatic update tests. Nothing here talks to the network or touches a real
// install: releases come from a mock server on 127.0.0.1, the clock and the
// install method are parameters, and the "installed binary" is always a file
// in a temporary directory named by the test. No test relies on
// process.execPath, which in a test run is the runtime itself.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { createHash } from "crypto"
import { $ } from "bun"
import { Brand } from "@opencode-ai/core/brand/brand"
import { RafikiAutoupdate } from "../../src/rafiki/autoupdate"

const CURRENT = "1.0.0"
const NEWER = "1.1.0"
const asset = Brand.release.asset("linux", "x64")
const HOUR = 60 * 60 * 1000

let server: ReturnType<typeof Bun.serve>
let work: string
let archive: Uint8Array
let sums: string
let tampered = false
const requests: string[] = []
const saved: Record<string, string | undefined> = {}
const ENV = [Brand.env.releaseAPI, Brand.env.releaseBase, Brand.env.allowHttpLoopback, Brand.env.disableAutoupdate, "OPENCODE_DISABLE_AUTOUPDATE"]

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), "rafikicode-autoupdate-test-"))
  const src = path.join(work, "src")
  await fs.mkdir(src)
  await fs.writeFile(path.join(src, Brand.name), `#!/bin/sh\necho "${NEWER}"\n`, { mode: 0o755 })
  await $`tar -czf ${path.join(work, asset)} -C ${src} ${Brand.name}`.quiet()
  archive = new Uint8Array(await fs.readFile(path.join(work, asset)))
  sums = `${createHash("sha256").update(archive).digest("hex")}  ${asset}\n`

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      requests.push(url.pathname)
      if (url.pathname === "/dl/latest") {
        return new Response(null, { status: 302, headers: { location: `/dl/tag/v${NEWER}` } })
      }
      if (url.pathname === `/dl/download/v${NEWER}/${Brand.release.checksums}`) return new Response(sums)
      if (url.pathname === `/dl/download/v${NEWER}/${asset}`) {
        const body = tampered ? new Uint8Array([...archive, 1, 2, 3]) : archive
        return new Response(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer)
      }
      return new Response("not found", { status: 404 })
    },
  })
  for (const name of ENV) saved[name] = process.env[name]
  process.env[Brand.env.allowHttpLoopback] = "1"
  process.env[Brand.env.releaseAPI] = `http://127.0.0.1:${server.port}/api`
  process.env[Brand.env.releaseBase] = `http://127.0.0.1:${server.port}/dl`
  delete process.env[Brand.env.disableAutoupdate]
  delete process.env["OPENCODE_DISABLE_AUTOUPDATE"]
})

afterAll(async () => {
  server?.stop(true)
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  await fs.rm(work, { recursive: true, force: true })
})

beforeEach(() => {
  requests.length = 0
  tampered = false
})

// One fake install: an update directory, an install directory holding the
// "installed" binary, and a configuration directory.
async function install(name: string) {
  const root = path.join(work, name)
  const dir = path.join(root, "state", "update")
  const bin = path.join(root, "bin")
  const config = path.join(root, "config")
  await fs.mkdir(bin, { recursive: true })
  await fs.mkdir(config, { recursive: true })
  const execPath = path.join(bin, Brand.name)
  await fs.writeFile(execPath, `#!/bin/sh\necho "${CURRENT}"\n`, { mode: 0o755 })
  return { root, dir, bin, config, execPath }
}

function input(at: Awaited<ReturnType<typeof install>>, over: Partial<RafikiAutoupdate.CheckInput> = {}) {
  const notices: RafikiAutoupdate.Notice[] = []
  const lookups = { count: 0 }
  const value: RafikiAutoupdate.CheckInput = {
    autoupdate: true,
    current: CURRENT,
    release: true,
    dir: at.dir,
    now: () => 1_000_000_000_000,
    env: {},
    latest: async () => {
      lookups.count++
      return NEWER
    },
    method: async () => "curl",
    execPath: at.execPath,
    platform: "linux",
    arch: "x64",
    variant: "",
    notify: (notice) => notices.push(notice),
    ...over,
  }
  return { value, notices, lookups }
}

async function exists(file: string) {
  return fs.access(file).then(
    () => true,
    () => false,
  )
}

describe("the daily check", () => {
  test("downloads a newer release, verifies it and stages it without touching the installed binary", async () => {
    const at = await install("stage")
    const { value, notices } = input(at)
    expect(await RafikiAutoupdate.check(value)).toBe("staged")

    const staged = RafikiAutoupdate.readStaged(at.dir)!
    expect(staged.version).toBe(NEWER)
    expect(staged.asset).toBe(asset)
    // The published checksum of the archive, and the hash of what was unpacked.
    expect(sums).toContain(staged.assetSha256)
    const file = path.join(at.dir, staged.binary)
    expect(staged.sha256).toBe(createHash("sha256").update(await fs.readFile(file)).digest("hex"))
    expect((await $`${file}`.text()).trim()).toBe(NEWER)
    // Nothing is applied yet: the installed binary is still the old one.
    expect((await $`${at.execPath}`.text()).trim()).toBe(CURRENT)
    expect(notices).toEqual([{ kind: "staged", version: NEWER }])
    expect(requests).toEqual([`/dl/download/v${NEWER}/${Brand.release.checksums}`, `/dl/download/v${NEWER}/${asset}`])
  })

  test("asks at most once in 24 hours, and again after that", async () => {
    const at = await install("daily")
    let now = 1_000_000_000_000
    const { value, lookups } = input(at, { now: () => now, latest: async () => (lookups.count++, CURRENT) })
    expect(await RafikiAutoupdate.check(value)).toBe("current")
    expect(lookups.count).toBe(1)
    expect(RafikiAutoupdate.readState(at.dir).checkedAt).toBe(now)

    now += 23 * HOUR + 59 * 60 * 1000
    expect(await RafikiAutoupdate.check(value)).toBe("throttled")
    expect(lookups.count).toBe(1)

    now += 2 * 60 * 1000
    expect(await RafikiAutoupdate.check(value)).toBe("current")
    expect(lookups.count).toBe(2)
    expect(requests).toEqual([])
  })

  test("a lookup that fails still counts as the day's check", async () => {
    const at = await install("offline")
    let now = 1_000_000_000_000
    const lookups = { count: 0 }
    const { value } = input(at, {
      now: () => now,
      latest: async () => {
        lookups.count++
        throw new Error("offline")
      },
    })
    expect(await RafikiAutoupdate.check(value)).toBe("failed")
    now += HOUR
    expect(await RafikiAutoupdate.check(value)).toBe("throttled")
    expect(lookups.count).toBe(1)
  })

  test("a clock set back does not silence the check", async () => {
    const at = await install("clock")
    let now = 1_000_000_000_000
    const { value, lookups } = input(at, { now: () => now, latest: async () => (lookups.count++, CURRENT) })
    await RafikiAutoupdate.check(value)
    now -= 10 * 24 * HOUR
    expect(await RafikiAutoupdate.check(value)).toBe("current")
    expect(lookups.count).toBe(2)
  })

  test("autoupdate false does nothing: no lookup, no download, no state", async () => {
    const at = await install("off-config")
    const { value, notices, lookups } = input(at, { autoupdate: false })
    expect(await RafikiAutoupdate.check(value)).toBe("disabled")
    expect(lookups.count).toBe(0)
    expect(requests).toEqual([])
    expect(notices).toEqual([])
    expect(await exists(at.dir)).toBe(false)
  })

  for (const name of [Brand.env.disableAutoupdate, "OPENCODE_DISABLE_AUTOUPDATE"]) {
    test(`${name}=1 does nothing`, async () => {
      const at = await install(`off-${name}`)
      const { value, lookups } = input(at, { env: { [name]: "1" } })
      expect(await RafikiAutoupdate.check(value)).toBe("disabled")
      expect(lookups.count).toBe(0)
      expect(requests).toEqual([])
    })
  }

  test("switching it off discards an update that was already staged", async () => {
    const at = await install("off-after-stage")
    const first = input(at)
    expect(await RafikiAutoupdate.check(first.value)).toBe("staged")
    expect(RafikiAutoupdate.readStaged(at.dir)).toBeDefined()
    expect(await RafikiAutoupdate.check(input(at, { autoupdate: false }).value)).toBe("disabled")
    expect(RafikiAutoupdate.readStaged(at.dir)).toBeUndefined()
    expect((await fs.readdir(at.dir)).sort()).toEqual(["state.json"])
  })

  test("notify offers the update and downloads nothing", async () => {
    const at = await install("notify")
    const { value, notices } = input(at, { autoupdate: "notify" })
    expect(await RafikiAutoupdate.check(value)).toBe("notified")
    expect(notices).toEqual([{ kind: "available", version: NEWER }])
    expect(requests).toEqual([])
    expect(RafikiAutoupdate.readStaged(at.dir)).toBeUndefined()
  })

  for (const [method, command] of [
    ["npm", "npm install -g rafikicode@latest"],
    ["brew", "brew upgrade paneotech-dev/tap/rafikicode"],
    ["winget", "winget upgrade --id PaneoTech.RafikiCode --exact"],
  ] as const) {
    test(`an install owned by ${method} is told the command and is never replaced`, async () => {
      const at = await install(`manager-${method}`)
      const { value, notices } = input(at, { method: async () => method })
      expect(await RafikiAutoupdate.check(value)).toBe("manual")
      expect(notices).toEqual([{ kind: "manual", version: NEWER, command }])
      expect(requests).toEqual([])
      expect(RafikiAutoupdate.readStaged(at.dir)).toBeUndefined()
      expect(RafikiAutoupdate.toastFor(notices[0] as Extract<RafikiAutoupdate.Notice, { kind: "manual" }>).message).toContain(command)
    })
  }

  test("a source run or a build that is not a release never checks", async () => {
    const at = await install("not-release")
    const { value, lookups } = input(at, { release: false })
    expect(await RafikiAutoupdate.check(value)).toBe("not-release")
    expect(lookups.count).toBe(0)
  })

  test("an older or equal version is not an update", async () => {
    const at = await install("older")
    const { value, notices } = input(at, { latest: async () => "0.9.0" })
    expect(await RafikiAutoupdate.check(value)).toBe("current")
    expect(notices).toEqual([])
    expect(requests).toEqual([])
  })

  test("a download that does not match the published checksum is not staged", async () => {
    const at = await install("tampered-download")
    tampered = true
    const { value, notices } = input(at)
    expect(await RafikiAutoupdate.check(value)).toBe("failed")
    expect(RafikiAutoupdate.readStaged(at.dir)).toBeUndefined()
    expect((await fs.readdir(at.dir)).sort()).toEqual(["state.json"])
    expect(notices).toEqual([])
    await expect(RafikiAutoupdate.stage(NEWER, value)).rejects.toThrow(/Checksum mismatch/)
  })

  test("an install directory that cannot be written is told so and nothing is downloaded", async () => {
    // Root writes anywhere, so this can only be shown as an unprivileged user.
    if (process.getuid?.() === 0) return
    const at = await install("readonly")
    await fs.chmod(at.bin, 0o555)
    try {
      const { value, notices } = input(at)
      expect(await RafikiAutoupdate.check(value)).toBe("manual")
      expect(notices[0]).toMatchObject({ kind: "manual", version: NEWER })
      expect(requests).toEqual([])
    } finally {
      await fs.chmod(at.bin, 0o755)
    }
  })
})

describe("applying a staged update at the next start", () => {
  async function staged(name: string) {
    const at = await install(name)
    expect(await RafikiAutoupdate.check(input(at).value)).toBe("staged")
    return at
  }

  function apply(at: Awaited<ReturnType<typeof install>>, over: Partial<RafikiAutoupdate.ApplyInput> = {}) {
    const lines: string[] = []
    const restarts = { count: 0 }
    const outcome = RafikiAutoupdate.applyStaged({
      dir: at.dir,
      configDir: at.config,
      current: CURRENT,
      release: true,
      env: {},
      args: [],
      execPath: at.execPath,
      // A compiled binary somewhere else in the test's directory, never the
      // real process.execPath.
      running: { execPath: path.join(at.root, "running"), compiled: true },
      platform: "linux",
      log: (line) => lines.push(line),
      restart: () => {
        restarts.count++
      },
      ...over,
    })
    return { outcome, lines, restarts }
  }

  test("nothing staged costs nothing and changes nothing", async () => {
    const at = await install("apply-none")
    const { outcome, restarts } = apply(at)
    expect(outcome).toBe("none")
    expect(restarts.count).toBe(0)
    expect(await exists(at.dir)).toBe(false)
  })

  test("replaces the installed binary, removes the staged files and starts the new one", async () => {
    const at = await staged("apply-ok")
    const { outcome, lines, restarts } = apply(at)
    expect(outcome).toBe("applied")
    expect(restarts.count).toBe(1)
    expect((await $`${at.execPath}`.text()).trim()).toBe(NEWER)
    expect((await fs.stat(at.execPath)).mode & 0o777).toBe(0o755)
    expect(await exists(`${at.execPath}.new`)).toBe(false)
    expect((await fs.readdir(at.dir)).sort()).toEqual(["state.json"])
    expect(lines).toEqual([`${Brand.name} updated from ${CURRENT} to ${NEWER}.`])
    // The second start finds nothing to do.
    expect(apply(at).outcome).toBe("none")
  })

  test("a staged binary that no longer matches its checksum is deleted, not installed", async () => {
    const at = await staged("apply-tampered")
    const manifest = RafikiAutoupdate.readStaged(at.dir)!
    await fs.appendFile(path.join(at.dir, manifest.binary), "\necho tampered\n")
    const { outcome, lines, restarts } = apply(at)
    expect(outcome).toBe("refused")
    expect(restarts.count).toBe(0)
    expect((await $`${at.execPath}`.text()).trim()).toBe(CURRENT)
    expect((await fs.readdir(at.dir)).sort()).toEqual(["state.json"])
    expect(lines[0]).toContain("no longer matches its checksum")
  })

  test("a manifest cannot point the install at a file outside the update directory", async () => {
    const at = await staged("apply-traversal")
    const outside = path.join(at.root, "outside")
    await fs.writeFile(outside, "#!/bin/sh\necho outside\n", { mode: 0o755 })
    const manifest = RafikiAutoupdate.readStaged(at.dir)!
    await fs.writeFile(
      path.join(at.dir, "staged.json"),
      JSON.stringify({
        ...manifest,
        binary: "../../outside",
        sha256: createHash("sha256").update(await fs.readFile(outside)).digest("hex"),
      }),
    )
    const { outcome } = apply(at)
    expect(outcome).toBe("refused")
    expect((await $`${at.execPath}`.text()).trim()).toBe(CURRENT)
  })

  test("autoupdate false in the global configuration file stops the apply and discards the download", async () => {
    const at = await staged("apply-config-off")
    await fs.writeFile(path.join(at.config, "config.json"), '{\n  // switched off after the download\n  "autoupdate": false\n}\n')
    const { outcome, restarts } = apply(at)
    expect(outcome).toBe("disabled")
    expect(restarts.count).toBe(0)
    expect((await $`${at.execPath}`.text()).trim()).toBe(CURRENT)
    expect(RafikiAutoupdate.readStaged(at.dir)).toBeUndefined()
  })

  test("the environment switch stops the apply for that process and keeps the download", async () => {
    const at = await staged("apply-env-off")
    const { outcome } = apply(at, { env: { [Brand.env.disableAutoupdate]: "1" } })
    expect(outcome).toBe("disabled")
    expect((await $`${at.execPath}`.text()).trim()).toBe(CURRENT)
    expect(RafikiAutoupdate.readStaged(at.dir)).toBeDefined()
  })

  test("update, upgrade and uninstall are left to do their own work", async () => {
    const at = await staged("apply-self-managing")
    for (const args of [["update"], ["upgrade", "0.9.0"], ["--print-logs", "uninstall"]]) {
      expect(apply(at, { args }).outcome).toBe("skipped")
    }
    expect((await $`${at.execPath}`.text()).trim()).toBe(CURRENT)
  })

  test("a staged version that is not newer than the installed one is discarded", async () => {
    const at = await staged("apply-stale")
    const { outcome, restarts } = apply(at, { current: NEWER })
    expect(outcome).toBe("discarded")
    expect(restarts.count).toBe(0)
    expect(RafikiAutoupdate.readStaged(at.dir)).toBeUndefined()
  })

  test("a build that is not a release never applies", async () => {
    const at = await staged("apply-not-release")
    expect(apply(at, { release: false }).outcome).toBe("skipped")
    expect((await $`${at.execPath}`.text()).trim()).toBe(CURRENT)
  })

  // The default target is the running executable. "The running executable"
  // here is the fake install's binary, passed in: no test names the real one.
  test("with no named target, a run from source is skipped even when told it is a release", async () => {
    const at = await staged("apply-from-source")
    const { outcome, restarts } = apply(at, { execPath: undefined, running: { execPath: at.execPath, compiled: false } })
    expect(outcome).toBe("skipped")
    expect(restarts.count).toBe(0)
    expect((await $`${at.execPath}`.text()).trim()).toBe(CURRENT)
    expect(RafikiAutoupdate.readStaged(at.dir)).toBeDefined()
  })

  test("a named target that is the runtime of a source run is skipped as well", async () => {
    const at = await staged("apply-from-source-named")
    const { outcome } = apply(at, { running: { execPath: at.execPath, compiled: false } })
    expect(outcome).toBe("skipped")
    expect((await $`${at.execPath}`.text()).trim()).toBe(CURRENT)
  })

  test("with no named target, a compiled binary replaces itself", async () => {
    const at = await staged("apply-compiled")
    const { outcome, restarts } = apply(at, { execPath: undefined, running: { execPath: at.execPath, compiled: true } })
    expect(outcome).toBe("applied")
    expect(restarts.count).toBe(1)
    expect((await $`${at.execPath}`.text()).trim()).toBe(NEWER)
  })

  test("the process started after an apply does not look for another", async () => {
    const at = await staged("apply-child")
    expect(apply(at, { env: { [Brand.env.updateApplied]: "1" } }).outcome).toBe("none")
  })

  test("a replace that fails keeps the current version, and the release is not downloaded again", async () => {
    const at = await staged("apply-fail")
    // The target's directory does not exist, so the copy next to it fails.
    const { outcome, lines } = apply(at, { execPath: path.join(at.root, "missing", Brand.name) })
    expect(outcome).toBe("failed")
    expect(lines[0]).toContain(`${Brand.name} update`)
    expect(RafikiAutoupdate.readState(at.dir).failed).toBe(NEWER)
    expect(RafikiAutoupdate.readStaged(at.dir)).toBeUndefined()

    requests.length = 0
    const next = input(at, { now: () => 2_000_000_000_000 })
    expect(await RafikiAutoupdate.check(next.value)).toBe("manual")
    expect(next.notices[0]).toMatchObject({ kind: "manual", version: NEWER })
    expect(requests).toEqual([])
  })
})

describe("the configuration switch read at start", () => {
  test("reads the global files the configuration service reads, later files winning", async () => {
    const dir = path.join(work, "config-order")
    await fs.mkdir(dir, { recursive: true })
    expect(RafikiAutoupdate.configuredOff(dir)).toBe(false)
    await fs.writeFile(path.join(dir, "config.json"), '{ "autoupdate": false }')
    expect(RafikiAutoupdate.configuredOff(dir)).toBe(true)
    await fs.writeFile(path.join(dir, "opencode.jsonc"), '{ "autoupdate": "notify" } // later file')
    expect(RafikiAutoupdate.configuredOff(dir)).toBe(false)
    await fs.writeFile(path.join(dir, "config.json"), "not json at all")
    expect(RafikiAutoupdate.configuredOff(dir)).toBe(false)
  })

  test("the seeded default is on", () => {
    expect(Brand.config().autoupdate).toBe(true)
  })
})
