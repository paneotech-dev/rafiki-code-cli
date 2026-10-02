// Install channels other than the installer script: the Homebrew formula and
// winget manifests rendered from a release's SHA256SUMS, and the npm wrapper
// package, installed here against a mock release on 127.0.0.1. Nothing talks to
// a registry, a tap or the network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { createHash } from "crypto"
import { $ } from "bun"
import { Brand } from "@opencode-ai/core/brand/brand"

const root = path.resolve(import.meta.dir, "../../../..")
const channels = path.join(root, "install/channels")
const npmDir = path.join(root, "install/npm")
const VERSION = "7.8.9"
const TARGETS = [
  "linux-x64.tar.gz",
  "linux-x64-baseline.tar.gz",
  "linux-x64-musl.tar.gz",
  "linux-x64-baseline-musl.tar.gz",
  "linux-arm64.tar.gz",
  "linux-arm64-musl.tar.gz",
  "darwin-arm64.zip",
  "darwin-x64.zip",
  "darwin-x64-baseline.zip",
  "windows-x64.zip",
  "windows-x64-baseline.zip",
  "windows-arm64.zip",
]

let work: string
let sumsFile: string
let server: ReturnType<typeof Bun.serve>
let tampered = false
const requests: string[] = []
// The one archive that really exists in the mock release: a shell script
// standing in for the binary, with the licence files beside it.
const realAsset = "rafikicode-linux-x64.tar.gz"
let archive: Uint8Array
const hashes = new Map<string, string>()

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), "rafikicode-channels-test-"))
  const src = path.join(work, "src")
  await fs.mkdir(src)
  await fs.writeFile(
    path.join(src, "rafikicode"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${VERSION}"; exit 0; fi\nif [ "$1" = "fail" ]; then exit 7; fi\necho "args: $*"\n`,
    { mode: 0o755 },
  )
  await fs.copyFile(path.join(root, "LICENSE"), path.join(src, "LICENSE"))
  await fs.copyFile(path.join(root, "NOTICE"), path.join(src, "NOTICE"))
  await $`tar -czf ${path.join(work, realAsset)} -C ${src} .`.quiet()
  archive = new Uint8Array(await fs.readFile(path.join(work, realAsset)))

  const lines: string[] = []
  for (const target of TARGETS) {
    const name = `rafikicode-${target}`
    const hash = name === realAsset ? createHash("sha256").update(archive).digest("hex") : createHash("sha256").update(name).digest("hex")
    hashes.set(name, hash)
    lines.push(`${hash}  ${name}`)
  }
  sumsFile = path.join(work, "SHA256SUMS")
  await fs.writeFile(sumsFile, lines.join("\n") + "\n")

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      requests.push(url.pathname)
      if (url.pathname === `/dl/download/v${VERSION}/${realAsset}`) {
        const body = tampered ? new Uint8Array([...archive, 9]) : archive
        return new Response(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer)
      }
      if (url.pathname === "/elsewhere") {
        return new Response(null, { status: 302, headers: { location: "http://releases.example.com/x" } })
      }
      return new Response("not found", { status: 404 })
    },
  })
})

afterAll(async () => {
  server?.stop(true)
  await fs.rm(work, { recursive: true, force: true })
})

describe("Homebrew formula and winget manifests", () => {
  async function render(sums = sumsFile, version = VERSION) {
    const out = await fs.mkdtemp(path.join(work, "render-"))
    const proc = Bun.spawnSync(["node", path.join(channels, "render.mjs"), "--version", version, "--sums", sums, "--out", out])
    return { out, exitCode: proc.exitCode, stderr: proc.stderr.toString() }
  }

  test("the formula points at this repository's release and carries the published hashes", async () => {
    const { out, exitCode } = await render()
    expect(exitCode).toBe(0)
    const formula = await fs.readFile(path.join(out, "homebrew/rafikicode.rb"), "utf8")
    expect(formula).toContain("class Rafikicode < Formula")
    expect(formula).toContain(`version "${VERSION}"`)
    expect(formula).toContain('license "MIT"')
    for (const name of ["rafikicode-darwin-arm64.zip", "rafikicode-darwin-x64.zip", "rafikicode-linux-arm64.tar.gz", "rafikicode-linux-x64.tar.gz"]) {
      expect(formula).toContain(`url "${Brand.release.base()}/download/v${VERSION}/${name}"`)
      expect(formula).toContain(`sha256 "${hashes.get(name)}"`)
    }
    // The licence files are installed with the binary.
    expect(formula).toContain('prefix.install "LICENSE", "NOTICE"')
    expect(formula).toContain(`brew upgrade ${Brand.brew.formula}`)
    expect(formula).not.toContain("{{")
    // Every download is from this product's own releases.
    for (const url of formula.matchAll(/url "([^"]+)"/g)) expect(url[1]).toStartWith(`${Brand.release.base()}/download/`)
  })

  test("the winget manifests name this product's identifier, archives and upper case hashes", async () => {
    const { out } = await render()
    const dir = path.join(out, "winget")
    expect((await fs.readdir(dir)).sort()).toEqual([
      `${Brand.winget.id}.installer.yaml`,
      `${Brand.winget.id}.locale.en-US.yaml`,
      `${Brand.winget.id}.yaml`,
    ])
    const installer = await fs.readFile(path.join(dir, `${Brand.winget.id}.installer.yaml`), "utf8")
    expect(installer).toContain(`PackageIdentifier: ${Brand.winget.id}`)
    expect(installer).toContain(`PackageVersion: ${VERSION}`)
    expect(installer).toContain("NestedInstallerType: portable")
    expect(installer).toContain("RelativeFilePath: rafikicode.exe")
    for (const [arch, name] of [["x64", "rafikicode-windows-x64.zip"], ["arm64", "rafikicode-windows-arm64.zip"]]) {
      expect(installer).toContain(`Architecture: ${arch}`)
      expect(installer).toContain(`InstallerUrl: ${Brand.release.base()}/download/v${VERSION}/${name}`)
      expect(installer).toContain(`InstallerSha256: ${hashes.get(name)!.toUpperCase()}`)
    }
    for (const file of await fs.readdir(dir)) {
      const text = await fs.readFile(path.join(dir, file), "utf8")
      expect(text).toContain(`PackageIdentifier: ${Brand.winget.id}`)
      expect(text).toContain("ManifestVersion: 1.6.0")
      expect(text).not.toContain("{{")
    }
  })

  test("a release missing an archive the channel needs fails the render", async () => {
    const partial = path.join(work, "SHA256SUMS.partial")
    const text = (await fs.readFile(sumsFile, "utf8")).split("\n").filter((line) => !line.includes("darwin-arm64")).join("\n")
    await fs.writeFile(partial, text)
    const { exitCode, stderr } = await render(partial)
    expect(exitCode).toBe(1)
    expect(stderr).toContain("SHA256SUMS has no entry for rafikicode-darwin-arm64.zip")
  })

  test("a version that is not a plain release is refused", async () => {
    const { exitCode, stderr } = await render(sumsFile, "7.8.9-rc.1")
    expect(exitCode).toBe(2)
    expect(stderr).toContain("must be a release version")
  })
})

describe("the npm wrapper package", () => {
  async function build() {
    const out = await fs.mkdtemp(path.join(work, "npm-"))
    const proc = Bun.spawnSync(["node", path.join(npmDir, "build.mjs"), "--version", VERSION, "--sums", sumsFile, "--out", out])
    expect(proc.exitCode).toBe(0)
    return path.join(out, "rafikicode")
  }

  // Not spawnSync: the mock release is served by this same process, and a
  // blocked event loop would never answer the download.
  async function node(pkg: string, script: string, args: string[] = [], extra: Record<string, string> = {}) {
    const proc = Bun.spawn(["node", path.join(pkg, script), ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: work,
        RAFIKICODE_RELEASE_BASE: `http://127.0.0.1:${server.port}/dl`,
        RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK: "1",
        RAFIKICODE_INSTALL_TARGET: "linux-x64",
        ...extra,
      },
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { exitCode: await proc.exited, stdout, stderr }
  }

  test("is assembled with the release version, every checksum, the licence and the notice, and no binary", async () => {
    const pkg = await build()
    const manifest = JSON.parse(await fs.readFile(path.join(pkg, "package.json"), "utf8"))
    expect(manifest.name).toBe(Brand.npm.meta)
    expect(manifest.version).toBe(VERSION)
    expect(manifest.license).toBe("MIT")
    expect(manifest.bin).toEqual({ rafikicode: "bin/rafikicode.js" })
    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.optionalDependencies).toBeUndefined()
    const checksums = JSON.parse(await fs.readFile(path.join(pkg, "checksums.json"), "utf8"))
    expect(Object.keys(checksums).sort()).toEqual(TARGETS.map((target) => `rafikicode-${target}`).sort())
    expect(checksums[realAsset]).toBe(hashes.get(realAsset))
    expect(await fs.readFile(path.join(pkg, "LICENSE"), "utf8")).toBe(await fs.readFile(path.join(root, "LICENSE"), "utf8"))
    expect(await fs.readFile(path.join(pkg, "NOTICE"), "utf8")).toBe(await fs.readFile(path.join(root, "NOTICE"), "utf8"))
    expect((await fs.readdir(pkg)).sort()).toEqual(["LICENSE", "NOTICE", "README.md", "bin", "checksums.json", "install.js", "package.json"])
  })

  test("postinstall downloads the archive of its own version, verifies it and unpacks the binary", async () => {
    const pkg = await build()
    requests.length = 0
    const run = await node(pkg, "install.js")
    expect(run.stderr).toContain(`downloading ${realAsset} for version ${VERSION}`)
    expect(run.exitCode).toBe(0)
    expect(requests).toEqual([`/dl/download/v${VERSION}/${realAsset}`])
    const binary = path.join(pkg, "vendor/rafikicode")
    expect((await $`${binary} --version`.text()).trim()).toBe(VERSION)
    // The licence files of the archive arrive with the binary.
    expect(await fs.readFile(path.join(pkg, "vendor/LICENSE"), "utf8")).toContain("MIT License")
    // A second run finds the binary in place and downloads nothing.
    requests.length = 0
    expect((await node(pkg, "install.js")).exitCode).toBe(0)
    expect(requests).toEqual([])
  })

  test("the launcher passes arguments and the exit status through", async () => {
    const pkg = await build()
    expect((await node(pkg, "install.js")).exitCode).toBe(0)
    const ok = await node(pkg, "bin/rafikicode.js", ["run", "hello world"])
    expect(ok.exitCode).toBe(0)
    expect(ok.stdout.trim()).toBe("args: run hello world")
    expect((await node(pkg, "bin/rafikicode.js", ["fail"])).exitCode).toBe(7)
  })

  test("the launcher downloads on first use when install scripts were skipped", async () => {
    const pkg = await build()
    requests.length = 0
    const run = await node(pkg, "bin/rafikicode.js", ["--version"])
    expect(run.exitCode).toBe(0)
    expect(run.stdout.trim()).toBe(VERSION)
    expect(requests).toEqual([`/dl/download/v${VERSION}/${realAsset}`])
  })

  test("an archive that does not match the checksum in the package is refused and nothing is left behind", async () => {
    const pkg = await build()
    tampered = true
    try {
      const run = await node(pkg, "install.js")
      expect(run.exitCode).toBe(1)
      expect(run.stderr).toContain(`Checksum mismatch for ${realAsset}`)
      expect(run.stderr).toContain("nothing was installed")
    } finally {
      tampered = false
    }
    expect((await fs.readdir(pkg)).filter((name) => name.includes("vendor"))).toEqual([])
  })

  test("a build the release does not publish is named, with the ones it does", async () => {
    const pkg = await build()
    const run = await node(pkg, "install.js", [], { RAFIKICODE_INSTALL_TARGET: "linux-riscv64" })
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toContain("publishes no build named rafikicode-linux-riscv64.tar.gz")
    expect(run.stderr).toContain("rafikicode-linux-x64.tar.gz")
  })

  test("a release base that is not https or loopback is refused before any request", async () => {
    const pkg = await build()
    requests.length = 0
    const run = await node(pkg, "install.js", [], { RAFIKICODE_RELEASE_BASE: "http://releases.example.com/dl" })
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toContain("RAFIKICODE_RELEASE_BASE must be an https URL")
    expect(requests).toEqual([])
    const noSwitch = await node(pkg, "install.js", [], { RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK: "" })
    expect(noSwitch.exitCode).toBe(1)
    expect(requests).toEqual([])
  })

  // The publish script, with the token explicitly empty so that this test can
  // never publish anything whatever the environment it runs in holds.
  test("publishing without NPM_TOKEN stops with a message naming the secret", async () => {
    const proc = Bun.spawn(["bun", "run", path.join(root, "packages/opencode/script/publish-npm.ts")], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: work,
        OPENCODE_VERSION: VERSION,
        OPENCODE_CHANNEL: "latest",
        RAFIKICODE_SHA256SUMS: sumsFile,
        NODE_AUTH_TOKEN: "",
        DRY_RUN: "",
        PACK: "",
      },
    })
    const stderr = await new Response(proc.stderr).text()
    expect(await proc.exited).toBe(1)
    expect(stderr).toContain("NPM_TOKEN is not set")
    expect(stderr).toContain(`rafikicode@${VERSION} cannot be published`)
  }, 60_000)

  test("the default download location is this repository's GitHub releases", async () => {
    const text = await fs.readFile(path.join(npmDir, "install.js"), "utf8")
    expect(text).toContain("https://github.com/${OWNER}/${REPO}/releases")
    expect(text).toContain(`const OWNER = "${Brand.release.owner}"`)
    expect(text).toContain(`const REPO = "${Brand.release.repo}"`)
  })
})
