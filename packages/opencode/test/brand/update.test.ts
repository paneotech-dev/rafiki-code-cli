// Self updater tests against a local mock release server. Nothing here talks
// to the network: the brand module's release URLs are overridden through the
// environment variables the module documents.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { createHash } from "crypto"
import { $ } from "bun"
import { Brand } from "@opencode-ai/core/brand/brand"
import { RafikiUpdate } from "../../src/rafiki/update"

// 0 lets the kernel pick a free port; the URLs below read it back from the server.
const PORT = Number(process.env["RAFIKICODE_TEST_UPDATE_PORT"] ?? 0)
const VERSION = "9.9.9"
const asset = Brand.release.asset("linux", "x64")

let server: ReturnType<typeof Bun.serve>
let work: string
let archive: Uint8Array
let goodSums: string
let tampered = false
// Paths the mock release server was asked for, to prove a refusal fetched nothing.
const requests: string[] = []

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), "rafikicode-update-test-"))
  const bin = path.join(work, Brand.name)
  await fs.writeFile(bin, `#!/bin/sh\necho "${VERSION}"\n`, { mode: 0o755 })
  await $`tar -czf ${path.join(work, asset)} -C ${work} ${Brand.name}`.quiet()
  archive = new Uint8Array(await fs.readFile(path.join(work, asset)))
  const digest = createHash("sha256").update(archive).digest("hex")
  goodSums = `${digest}  ${asset}\n`

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    fetch(req) {
      const url = new URL(req.url)
      requests.push(url.pathname)
      if (url.pathname === "/api/releases/latest") {
        return Response.json({ tag_name: `v${VERSION}` })
      }
      if (url.pathname === `/dl/download/v${VERSION}/${Brand.release.checksums}`) {
        return new Response(goodSums)
      }
      if (url.pathname === `/dl/download/v${VERSION}/${asset}`) {
        const body = tampered ? new Uint8Array([...archive, 1, 2, 3]) : archive
        const buffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
        return new Response(buffer, { headers: { "content-type": "application/gzip" } })
      }
      return new Response("not found", { status: 404 })
    },
  })
  process.env[Brand.env.releaseAPI] = `http://127.0.0.1:${server.port}/api`
  process.env[Brand.env.releaseBase] = `http://127.0.0.1:${server.port}/dl`
})

afterAll(async () => {
  server?.stop(true)
  delete process.env[Brand.env.releaseAPI]
  delete process.env[Brand.env.releaseBase]
  await fs.rm(work, { recursive: true, force: true })
})

describe("RafikiUpdate", () => {
  test("release locations come from the brand module", () => {
    delete process.env[Brand.env.releaseAPI]
    delete process.env[Brand.env.releaseBase]
    expect(Brand.release.api()).toBe(`https://api.github.com/repos/${Brand.release.owner}/${Brand.release.repo}`)
    expect(Brand.release.base()).toBe(`https://github.com/${Brand.release.owner}/${Brand.release.repo}/releases`)
    process.env[Brand.env.releaseAPI] = `http://127.0.0.1:${server.port}/api`
    process.env[Brand.env.releaseBase] = `http://127.0.0.1:${server.port}/dl`
  })

  test("a release override that is not https or loopback is not used, and update refuses to run", async () => {
    const saved = process.env[Brand.env.releaseBase]
    process.env[Brand.env.releaseBase] = "http://releases.example.com/dl"
    try {
      expect(Brand.release.base()).toBe(`https://github.com/${Brand.release.owner}/${Brand.release.repo}/releases`)
      expect(Brand.release.overrideProblem()).toContain(Brand.env.releaseBase)
      let calls = 0
      const target = path.join(work, "untouched-binary")
      await fs.writeFile(target, "old", { mode: 0o755 })
      const run = RafikiUpdate.apply({
        version: VERSION,
        execPath: target,
        variant: "",
        fetch: (async () => {
          calls++
          return new Response("no")
        }) as unknown as typeof fetch,
      })
      await expect(run).rejects.toThrow(/must be an https URL/)
      expect(calls).toBe(0)
      expect(await fs.readFile(target, "utf8")).toBe("old")
      process.env[Brand.env.releaseBase] = "https://mirror.example.com/releases"
      expect(Brand.release.base()).toBe("https://mirror.example.com/releases")
      expect(Brand.release.overrideProblem()).toBeUndefined()
    } finally {
      process.env[Brand.env.releaseBase] = saved
    }
  })

  test("the installer script refuses a release override that is not https or loopback", async () => {
    const script = path.resolve(import.meta.dir, "../../../../install/install.sh")
    const refused = Bun.spawnSync(["bash", script, "--dry-run"], {
      env: { PATH: process.env.PATH ?? "", HOME: work, RAFIKICODE_RELEASE_API: "http://api.example.com" },
    })
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr.toString()).toContain("RAFIKICODE_RELEASE_API must be an https URL")
    const help = Bun.spawnSync(["bash", script, "--help"], {
      env: { PATH: process.env.PATH ?? "", HOME: work, RAFIKICODE_RELEASE_BASE: `http://127.0.0.1:${server.port}/dl` },
    })
    expect(help.exitCode).toBe(0)
  })

  test("asset names match the build script output", () => {
    expect(RafikiUpdate.assetName("linux", "x64")).toBe("rafikicode-linux-x64.tar.gz")
    expect(RafikiUpdate.assetName("linux", "aarch64", "musl")).toBe("rafikicode-linux-arm64-musl.tar.gz")
    expect(RafikiUpdate.assetName("darwin", "arm64")).toBe("rafikicode-darwin-arm64.zip")
    expect(RafikiUpdate.assetName("win32", "x64", "baseline")).toBe("rafikicode-windows-x64-baseline.zip")
  })

  test("parses sha256sum style checksum files", () => {
    const sums = RafikiUpdate.parseChecksums(
      ["a".repeat(64) + "  rafikicode-linux-x64.tar.gz", "B".repeat(64) + " *rafikicode-darwin-arm64.zip", "junk line", ""].join(
        "\n",
      ),
    )
    expect(sums.get("rafikicode-linux-x64.tar.gz")).toBe("a".repeat(64))
    expect(sums.get("rafikicode-darwin-arm64.zip")).toBe("b".repeat(64))
    expect(sums.size).toBe(2)
  })

  test("reads the latest version from the release API", async () => {
    expect(await RafikiUpdate.latest()).toBe(VERSION)
  })

  test("downloads, verifies, and replaces the binary atomically", async () => {
    const target = path.join(work, "installed", Brand.name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, "#!/bin/sh\necho old\n", { mode: 0o755 })
    const lines: string[] = []
    const result = await RafikiUpdate.apply({
      execPath: target,
      platform: "linux",
      arch: "x64",
      variant: "",
      onProgress: (l) => lines.push(l),
    })
    expect(result.version).toBe(VERSION)
    expect(result.asset).toBe(asset)
    expect(result.path).toBe(target)
    const text = await $`${target}`.text()
    expect(text.trim()).toBe(VERSION)
    const stat = await fs.stat(target)
    expect(stat.mode & 0o777).toBe(0o755)
    await expect(fs.access(`${target}.new`)).rejects.toThrow()
    expect(lines.some((l) => l.startsWith("Downloading"))).toBe(true)
  })

  test("refuses a download whose checksum does not match and leaves the binary alone", async () => {
    const target = path.join(work, "installed2", Brand.name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, "#!/bin/sh\necho old\n", { mode: 0o755 })
    tampered = true
    try {
      await expect(
        RafikiUpdate.apply({ execPath: target, platform: "linux", arch: "x64", variant: "" }),
      ).rejects.toThrow(/Checksum mismatch/)
    } finally {
      tampered = false
    }
    expect(await fs.readFile(target, "utf8")).toContain("echo old")
    await expect(fs.access(`${target}.new`)).rejects.toThrow()
  })

  test("fails clearly when the version has no checksum entry for this platform", async () => {
    const target = path.join(work, "installed3", Brand.name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, "old", { mode: 0o755 })
    await expect(
      RafikiUpdate.apply({ execPath: target, platform: "darwin", arch: "arm64", variant: "" }),
    ).rejects.toThrow(/has no entry for rafikicode-darwin-arm64.zip/)
    await expect(
      RafikiUpdate.apply({ execPath: target, version: "1.0.0", platform: "linux", arch: "x64", variant: "" }),
    ).rejects.toThrow(/Could not download SHA256SUMS/)
  })

  test("automatic updates stay off by default", () => {
    expect(Brand.config().autoupdate).toBe(false)
  })
})

// The command users run, as a subprocess: the https rule must hold on the path
// "rafikicode update" really takes, not only inside RafikiUpdate.apply().
describe("rafikicode update, the command", () => {
  const root = path.resolve(import.meta.dir, "../..")

  async function update(extra: Record<string, string>) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "rafikicode-update-cmd-"))
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
      ...extra,
    }
    delete env["XDG_CONFIG_HOME"]
    delete env["CI"]
    delete env["GITHUB_ACTIONS"]
    try {
      const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "update"], {
        cwd: home,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: env as Record<string, string>,
      })
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      const exitCode = await proc.exited
      return { exitCode, all: (stdout + stderr).replace(/\x1b\[[0-9;]*m/g, "") }
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  }

  test("an http release API is refused before any lookup, exit 2, nothing downloaded", async () => {
    const before = requests.length
    const result = await update({
      [Brand.env.releaseAPI]: "http://api.example.com",
      [Brand.env.releaseBase]: `http://127.0.0.1:${server.port}/dl`,
    })
    expect(result.exitCode).toBe(2)
    expect(result.all).toContain(`${Brand.env.releaseAPI} must be an https URL`)
    expect(result.all).toContain("Nothing was installed.")
    expect(result.all).not.toContain("Using method")
    expect(result.all).not.toContain("api.github.com")
    expect(requests.length).toBe(before)
  }, 60_000)

  test("an http release base is refused the same way", async () => {
    const before = requests.length
    const result = await update({
      [Brand.env.releaseAPI]: `http://127.0.0.1:${server.port}/api`,
      [Brand.env.releaseBase]: "http://releases.example.com/dl",
    })
    expect(result.exitCode).toBe(2)
    expect(result.all).toContain(`${Brand.env.releaseBase} must be an https URL`)
    expect(result.all).toContain("Nothing was installed.")
    expect(requests.length).toBe(before)
  }, 60_000)

  test("loopback and https overrides pass the check the command runs first", () => {
    const saved = { api: process.env[Brand.env.releaseAPI], base: process.env[Brand.env.releaseBase], code: process.exitCode }
    const lines: string[] = []
    try {
      for (const value of [`http://127.0.0.1:${server.port}/api`, "http://localhost:4100/api", "http://[::1]:4100/api", "https://mirror.example.com/api"]) {
        process.env[Brand.env.releaseAPI] = value
        expect(RafikiUpdate.refusedOverride((line) => lines.push(line))).toBe(false)
      }
      expect(lines).toEqual([])
      process.env[Brand.env.releaseAPI] = "http://127.0.0.2/api"
      expect(RafikiUpdate.refusedOverride((line) => lines.push(line))).toBe(true)
      expect(lines[0]).toContain("Nothing was installed.")
      expect(process.exitCode).toBe(2)
    } finally {
      process.env[Brand.env.releaseAPI] = saved.api
      process.env[Brand.env.releaseBase] = saved.base
      process.exitCode = saved.code
    }
  })
})
