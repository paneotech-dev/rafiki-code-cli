// The pull request review action installs a pinned release: no remote script,
// a required version and sha256, and a checksum check before unpacking.
// install.sh runs here against a local mock release server.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { createHash } from "crypto"
import { spawnSync } from "child_process"

const repo = path.resolve(import.meta.dir, "../../../..")
const actionDir = path.join(repo, ".github/actions/rafikicode-review")
const script = path.join(actionDir, "install.sh")
const VERSION = "9.9.9"
const asset = "rafikicode-linux-x64.tar.gz"

let work: string
let digest: string
let server: ReturnType<typeof Bun.serve>
let requests: string[] = []

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-action-"))
  const stage = path.join(work, "stage")
  fs.mkdirSync(stage)
  fs.writeFileSync(path.join(stage, "rafikicode"), `#!/bin/sh\necho ${VERSION}\n`, { mode: 0o755 })
  const tar = spawnSync("tar", ["-czf", path.join(work, asset), "-C", stage, "rafikicode"])
  expect(tar.status).toBe(0)
  const bytes = fs.readFileSync(path.join(work, asset))
  digest = createHash("sha256").update(bytes).digest("hex")
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      requests.push(url.pathname)
      if (url.pathname === `/dl/download/v${VERSION}/${asset}`) return new Response(bytes)
      return new Response("not found", { status: 404 })
    },
  })
})

afterAll(() => {
  server.stop(true)
  fs.rmSync(work, { recursive: true, force: true })
})

// Async on purpose: the mock server runs in this process, so a blocking spawn
// would stop it from answering the script's download.
async function install(env: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(work, "bin-"))
  requests = []
  const child = Bun.spawn(["bash", script], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: work,
      RUNNER_OS: "Linux",
      RUNNER_ARCH: "X64",
      INSTALL_DIR: dir,
      RAFIKICODE_RELEASE_BASE: `http://127.0.0.1:${server.port}/dl`,
      RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK: "1",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, status, dir, installed: fs.existsSync(path.join(dir, "rafikicode")) }
}

describe("review action install", () => {
  test("action.yml runs the local install script and pipes no remote script into a shell", () => {
    const yml = fs.readFileSync(path.join(actionDir, "action.yml"), "utf8")
    expect(yml).not.toMatch(/\|\s*(ba)?sh\b/)
    expect(yml).not.toContain("installer-url")
    expect(yml).toContain('bash "${GITHUB_ACTION_PATH}/install.sh"')
    expect(yml).toMatch(/\n  version:\n[^\n]*\n    required: true\n    default: ""/)
    expect(yml).toMatch(/\n  sha256:\n[^\n]*\n    required: true\n    default: ""/)
  })

  test("installs the pinned version when the archive matches the pinned hash", async () => {
    const r = await install({ VERSION, SHA256: digest })
    expect(r.stderr).toBe("")
    expect(r.status).toBe(0)
    expect(r.installed).toBe(true)
    expect(spawnSync(path.join(r.dir, "rafikicode"), { encoding: "utf8" }).stdout.trim()).toBe(VERSION)
  })

  test("accepts SHA256SUMS lines and picks the runner's asset", async () => {
    const sums = `${"0".repeat(64)}  rafikicode-darwin-arm64.zip\n${digest}  ${asset}\n`
    const r = await install({ VERSION: `v${VERSION}`, SHA256: sums })
    expect(r.status).toBe(0)
    expect(r.installed).toBe(true)
  })

  test("a changed archive stops the install and leaves nothing behind", async () => {
    const r = await install({ VERSION, SHA256: "f".repeat(64) })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("checksum mismatch")
    expect(r.installed).toBe(false)
  })

  test("refuses to run without a version or a hash, before any download", async () => {
    const noVersion = await install({ SHA256: digest })
    expect(noVersion.status).toBe(1)
    expect(noVersion.stderr).toContain("version input is required")
    const latest = await install({ VERSION: "latest", SHA256: digest })
    expect(latest.status).toBe(1)
    const noHash = await install({ VERSION })
    expect(noHash.status).toBe(1)
    expect(noHash.stderr).toContain("sha256 input is required")
    const wrongAsset = await install({ VERSION, SHA256: `${digest}  rafikicode-windows-x64.zip` })
    expect(wrongAsset.status).toBe(1)
    expect(wrongAsset.stderr).toContain(`no 64 character hash for ${asset}`)
    expect(requests).toEqual([])
  })

  test("refuses a release base that is not https", async () => {
    const r = await install({ VERSION, SHA256: digest, RAFIKICODE_RELEASE_BASE: "http://releases.example.com/dl" })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("must be an https URL")
  })

  test("plain http needs a literal loopback address and the test switch; bypass forms are refused before any download", async () => {
    const port = server.port
    const refused = [
      { base: `http://127.0.0.1:${port}/dl`, allow: "" },
      { base: `http://localhost:${port}/dl`, allow: "1" },
      { base: `http://127.0.0.1:${port}@releases.example.com/dl`, allow: "1" },
      { base: `http://127.0.0.1@releases.example.com/dl`, allow: "1" },
      { base: `http://user@127.0.0.1:${port}/dl`, allow: "1" },
      { base: `http://[::ffff:127.0.0.1]:${port}/dl`, allow: "1" },
      { base: `http://127.1:${port}/dl`, allow: "1" },
      { base: `http://2130706433:${port}/dl`, allow: "1" },
      { base: `http://127.0.0.1.nip.io:${port}/dl`, allow: "1" },
      { base: `https://github.com@releases.example.com/dl`, allow: "1" },
    ]
    for (const item of refused) {
      const r = await install({ VERSION, SHA256: digest, RAFIKICODE_RELEASE_BASE: item.base, RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK: item.allow })
      expect(r.status, item.base).toBe(1)
      expect(r.stderr, item.base).toContain("must be an https URL")
      expect(r.installed, item.base).toBe(false)
    }
    expect(requests).toEqual([])
  })
})
