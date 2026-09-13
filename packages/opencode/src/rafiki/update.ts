// Rafiki Code self updater. Fork only: replaces the upstream "curl" upgrade
// path (which piped an install script into a shell) with a direct download
// from this fork's GitHub releases, a SHA256SUMS check, and an atomic swap of
// the running binary. Every URL and name comes from the brand module, and every
// external input can be overridden so tests run against a local mock server.
import fs from "fs/promises"
import path from "path"
import os from "os"
import { createHash } from "crypto"
import { spawn } from "child_process"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Contract from "./contract"

export namespace RafikiUpdate {
  export interface Options {
    // Version to install without the leading v. Omitted means latest.
    version?: string
    // Path of the binary to replace. Defaults to the running executable.
    execPath?: string
    // Platform and architecture in Node terms (linux, darwin, win32; x64, arm64).
    platform?: NodeJS.Platform
    arch?: string
    // Extra asset name suffix such as "baseline" or "musl", detected when omitted.
    variant?: string
    // Fetch implementation, injectable for tests.
    fetch?: typeof fetch
    // Progress callback with a short human readable line.
    onProgress?: (line: string) => void
  }

  export interface Result {
    version: string
    path: string
    asset: string
    sha256: string
  }

  export class UpdateError extends Error {
    constructor(message: string) {
      super(message)
      this.name = "RafikiUpdateError"
    }
  }

  // Latest release tag from the releases API, without the leading v.
  export async function latest(opts: Pick<Options, "fetch"> = {}): Promise<string> {
    const f = opts.fetch ?? fetch
    const url = `${Brand.release.api()}/releases/latest`
    const res = await f(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": Brand.name } })
    if (!res.ok) throw new UpdateError(`Could not read the latest release (${res.status}) from ${url}`)
    const data = (await res.json()) as { tag_name?: string }
    if (!data.tag_name) throw new UpdateError("The latest release has no tag name")
    return data.tag_name.replace(/^v/, "")
  }

  // Asset file name for this machine, matching what script/build.ts produces.
  export function assetName(platform: NodeJS.Platform, arch: string, variant?: string) {
    const archName = arch === "aarch64" ? "arm64" : arch === "x86_64" ? "x64" : arch
    return Brand.release.asset(platform, archName, variant)
  }

  // Linux x64 machines without AVX2 need the baseline build; musl systems the musl build.
  export async function detectVariant(platform: NodeJS.Platform, arch: string): Promise<string> {
    if (platform !== "linux") {
      if (platform === "darwin" && arch === "x64") {
        const avx2 = await run("sysctl", ["-n", "hw.optional.avx2_0"])
        return avx2.trim() === "1" ? "" : "baseline"
      }
      return ""
    }
    const parts: string[] = []
    if (arch === "x64") {
      const cpuinfo = await fs.readFile("/proc/cpuinfo", "utf8").catch(() => "")
      if (!/(^|\s)avx2(\s|$)/im.test(cpuinfo)) parts.push("baseline")
    }
    const alpine = await fs
      .access("/etc/alpine-release")
      .then(() => true)
      .catch(() => false)
    const ldd = alpine ? "musl" : await run("ldd", ["--version"])
    if (/musl/i.test(ldd)) parts.push("musl")
    return parts.join("-")
  }

  // Parse a SHA256SUMS file (sha256sum format) into a name to hash map.
  export function parseChecksums(text: string): Map<string, string> {
    const map = new Map<string, string>()
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line)
      if (!match) continue
      map.set(path.basename(match[2].trim()), match[1].toLowerCase())
    }
    return map
  }

  export function sha256(data: Uint8Array) {
    return createHash("sha256").update(data).digest("hex")
  }

  // Download an asset and its checksum file, verify, and return the archive bytes.
  export async function download(version: string, asset: string, opts: Pick<Options, "fetch" | "onProgress"> = {}) {
    const f = opts.fetch ?? fetch
    const base = `${Brand.release.base()}/download/v${version}`
    const sumsURL = `${base}/${Brand.release.checksums}`
    const sumsRes = await f(sumsURL, { headers: { "User-Agent": Brand.name } })
    if (!sumsRes.ok) throw new UpdateError(`Could not download ${Brand.release.checksums} (${sumsRes.status}) from ${sumsURL}`)
    const sums = parseChecksums(await sumsRes.text())
    const expected = sums.get(asset)
    if (!expected) throw new UpdateError(`${Brand.release.checksums} for v${version} has no entry for ${asset}`)
    opts.onProgress?.(`Downloading ${asset}`)
    const assetURL = `${base}/${asset}`
    const res = await f(assetURL, { headers: { "User-Agent": Brand.name } })
    if (!res.ok) throw new UpdateError(`Could not download ${asset} (${res.status}) from ${assetURL}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const actual = sha256(bytes)
    if (actual !== expected) {
      throw new UpdateError(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}. Nothing was installed.`)
    }
    return { bytes, sha256: actual }
  }

  // Extract the archive into a temporary directory and return the binary path.
  export async function extract(asset: string, bytes: Uint8Array, platform: NodeJS.Platform) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${Brand.name}-update-`))
    const archive = path.join(dir, asset)
    await fs.writeFile(archive, bytes)
    // tar handles both .tar.gz and .zip on Linux (GNU tar with gzip), macOS
    // (bsdtar), and Windows 10 and later (bsdtar shipped with the OS).
    const args = asset.endsWith(".tar.gz") ? ["-xzf", archive, "-C", dir] : ["-xf", archive, "-C", dir]
    const code = await exit("tar", args)
    if (code !== 0) throw new UpdateError(`Could not extract ${asset} (tar exit ${code})`)
    const binary = path.join(dir, platform === "win32" ? `${Brand.name}.exe` : Brand.name)
    await fs.access(binary).catch(() => {
      throw new UpdateError(`${asset} does not contain ${path.basename(binary)}`)
    })
    return { dir, binary }
  }

  // Put the new binary in place of the old one without a window where the
  // path is missing: write next to the target, then rename over it. Windows
  // cannot replace a running executable, so the old file is moved aside first.
  export async function replace(source: string, target: string, platform: NodeJS.Platform) {
    const staged = `${target}.new`
    await fs.copyFile(source, staged)
    if (platform !== "win32") await fs.chmod(staged, 0o755)
    if (platform === "win32") {
      const old = `${target}.old`
      await fs.rm(old, { force: true })
      await fs.rename(target, old).catch(() => {})
    }
    await fs.rename(staged, target)
  }

  // Called first by the update command, before the install method is detected
  // or any release is looked up: a refused override stops the command with the
  // contract's usage exit code. True when it refused.
  export function refusedOverride(log: (line: string) => void = (line) => process.stderr.write(line + "\n")) {
    const problem = Brand.release.overrideProblem()
    if (!problem) return false
    log(`${problem} Nothing was installed.`)
    process.exitCode = Contract.EXIT.usage
    return true
  }

  // Full update: resolve the version, download, verify, extract, replace.
  export async function apply(opts: Options = {}): Promise<Result> {
    const problem = Brand.release.overrideProblem()
    if (problem) throw new UpdateError(`${problem} Nothing was installed.`)
    const platform = opts.platform ?? process.platform
    const arch = opts.arch ?? process.arch
    const execPath = opts.execPath ?? process.execPath
    const version = opts.version?.replace(/^v/, "") || (await latest(opts))
    const variant = opts.variant ?? (await detectVariant(platform, arch))
    const asset = assetName(platform, arch, variant)
    const { bytes, sha256: digest } = await download(version, asset, opts)
    const { dir, binary } = await extract(asset, bytes, platform)
    try {
      opts.onProgress?.(`Installing ${Brand.name} ${version} to ${execPath}`)
      await replace(binary, execPath, platform)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
    return { version, path: execPath, asset, sha256: digest }
  }

  async function run(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve) => {
      let out = ""
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
      child.stdout.on("data", (d) => (out += d))
      child.stderr.on("data", (d) => (out += d))
      child.on("error", () => resolve(""))
      child.on("close", () => resolve(out))
    })
  }

  async function exit(cmd: string, args: string[]): Promise<number> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true })
      child.on("error", () => resolve(127))
      child.on("close", (code) => resolve(code ?? 1))
    })
  }
}
