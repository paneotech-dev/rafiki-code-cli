#!/usr/bin/env node
// Downloads the rafikicode binary for this machine. Runs as the package's
// postinstall script, and again from the launcher when a package manager
// skipped install scripts.
//
// The package carries no binary. It carries checksums.json, written when the
// package is published from the SHA256SUMS of the GitHub release with the same
// version. The archive is fetched from that release, its SHA-256 is compared
// with the one in the package, and only then is it unpacked. A file that does
// not match is deleted and nothing is installed.
//
// No dependencies: Node 18 or later (for fetch) and the tar command.
"use strict"

const childProcess = require("child_process")
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

const APP = "rafikicode"
const OWNER = "paneotech-dev"
const REPO = "rafiki-code-cli"
const DEFAULT_BASE = `https://github.com/${OWNER}/${REPO}/releases`
const ALLOW_LOOPBACK = "RAFIKICODE_INSTALL_ALLOW_HTTP_LOOPBACK"
const BASE_OVERRIDE = "RAFIKICODE_RELEASE_BASE"
const MAX_REDIRECTS = 10

const root = __dirname
const vendor = path.join(root, "vendor")

function binaryName() {
  return process.platform === "win32" ? `${APP}.exe` : APP
}

function binaryPath() {
  return path.join(vendor, binaryName())
}

// https, or plain http to a literal loopback address with the test switch set:
// the same rule the installer script and the self updater apply.
function allowed(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  if (url.protocol === "https:") return true
  return (
    url.protocol === "http:" &&
    process.env[ALLOW_LOOPBACK] === "1" &&
    ["127.0.0.1", "[::1]"].includes(url.hostname)
  )
}

function releaseBase() {
  const override = process.env[BASE_OVERRIDE]
  if (!override) return DEFAULT_BASE
  if (!allowed(override)) {
    throw new Error(
      `${BASE_OVERRIDE} must be an https URL (http is accepted only for 127.0.0.1 or [::1] with ${ALLOW_LOOPBACK}=1). Nothing was installed.`,
    )
  }
  return override.replace(/\/+$/, "")
}

function isMusl() {
  if (process.platform !== "linux") return false
  try {
    if (fs.existsSync("/etc/alpine-release")) return true
  } catch {
    // A blocked probe is not an answer; fall through to ldd.
  }
  try {
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" })
    return `${result.stdout || ""}${result.stderr || ""}`.toLowerCase().includes("musl")
  } catch {
    return false
  }
}

// True when an x64 CPU has no AVX2 and needs the baseline build. Windows is
// not asked: the installer script there does not ask either, and the ordinary
// build is what it gets.
function needsBaseline() {
  if (process.arch !== "x64") return false
  if (process.platform === "linux") {
    try {
      return !/(^|\s)avx2(\s|$)/im.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }
  if (process.platform === "darwin") {
    try {
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], { encoding: "utf8", timeout: 1500 })
      return result.status === 0 && (result.stdout || "").trim() !== "1"
    } catch {
      return false
    }
  }
  return false
}

// The release asset for this machine, named the way the release workflow names
// its archives. RAFIKICODE_INSTALL_TARGET names a build outright.
function assetName() {
  const forced = process.env.RAFIKICODE_INSTALL_TARGET
  const platform = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform]
  const arch = { x64: "x64", arm64: "arm64" }[process.arch]
  if (!forced && (!platform || !arch)) {
    throw new Error(`${APP} publishes no build for ${process.platform} ${process.arch}.`)
  }
  let target = forced
  if (!target) {
    target = `${platform}-${arch}`
    if (needsBaseline()) target += "-baseline"
    if (isMusl()) target += "-musl"
  }
  if (!/^[a-z0-9-]+$/.test(target)) throw new Error(`RAFIKICODE_INSTALL_TARGET is not a build name: ${target}`)
  const ext = target.startsWith("linux-") ? ".tar.gz" : ".zip"
  return `${APP}-${target}${ext}`
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

async function get(url) {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, { headers: { "User-Agent": APP }, redirect: "manual" })
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null
    if (!location) return res
    const next = new URL(location, current).href
    if (!allowed(next)) {
      throw new Error(`Refused the redirect from ${current} to ${next}: releases are downloaded over https only. Nothing was installed.`)
    }
    current = next
  }
  throw new Error(`More than ${MAX_REDIRECTS} redirects from ${url}. Nothing was installed.`)
}

function extract(archive, dir) {
  // tar reads .tar.gz everywhere, and the bsdtar of macOS and of Windows 10 and
  // later reads .zip as well. Linux archives are always .tar.gz.
  const args = archive.endsWith(".tar.gz") ? ["-xzf", archive, "-C", dir] : ["-xf", archive, "-C", dir]
  const result = childProcess.spawnSync("tar", args, { stdio: "ignore", windowsHide: true })
  if (result.error) throw new Error(`Could not run tar to unpack ${path.basename(archive)}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`Could not unpack ${path.basename(archive)} (tar exit ${result.status}).`)
}

// True when the binary of this package's version is already in place.
function installed(version) {
  try {
    return fs.existsSync(binaryPath()) && fs.readFileSync(path.join(vendor, ".version"), "utf8").trim() === version
  } catch {
    return false
  }
}

async function install(log = (line) => process.stderr.write(line + "\n")) {
  const version = readJson(path.join(root, "package.json")).version
  if (installed(version)) return binaryPath()

  const asset = assetName()
  const checksums = readJson(path.join(root, "checksums.json"))
  const expected = checksums[asset]
  if (!expected) {
    throw new Error(
      `${APP} ${version} publishes no build named ${asset}. It publishes: ${Object.keys(checksums).sort().join(", ")}.`,
    )
  }

  const url = `${releaseBase()}/download/v${version}/${asset}`
  log(`${APP}: downloading ${asset} for version ${version}`)
  const res = await get(url)
  if (!res.ok) throw new Error(`Could not download ${asset} (${res.status}) from ${url}. Nothing was installed.`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const actual = crypto.createHash("sha256").update(bytes).digest("hex")
  if (actual !== String(expected).toLowerCase()) {
    throw new Error(
      `Checksum mismatch for ${asset}: expected ${expected}, got ${actual}. The download was discarded and nothing was installed.`,
    )
  }

  // Unpacked beside the target and renamed into place, so a failure leaves
  // either the previous install or none, never half of one.
  const staging = fs.mkdtempSync(path.join(root, ".vendor-"))
  try {
    const archive = path.join(staging, asset)
    fs.writeFileSync(archive, bytes)
    extract(archive, staging)
    fs.rmSync(archive, { force: true })
    const binary = path.join(staging, binaryName())
    if (!fs.existsSync(binary)) throw new Error(`${asset} does not contain ${binaryName()}.`)
    if (process.platform !== "win32") fs.chmodSync(binary, 0o755)
    fs.writeFileSync(path.join(staging, ".version"), version + "\n")
    fs.rmSync(vendor, { recursive: true, force: true })
    fs.renameSync(staging, vendor)
  } catch (cause) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw cause
  }
  return binaryPath()
}

module.exports = { install, installed, assetName, binaryPath, releaseBase, allowed }

if (require.main === module) {
  install().catch((cause) => {
    process.stderr.write(`${APP}: ${cause && cause.message ? cause.message : cause}\n`)
    process.stderr.write(
      `${APP}: other ways to install are at https://github.com/${OWNER}/${REPO}/blob/main/docs/install.md\n`,
    )
    process.exit(1)
  })
}
