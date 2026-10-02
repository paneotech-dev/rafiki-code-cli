// Automatic updates. Fork only.
//
// What it does, in the order a user meets it:
//
//   1. Once a day at most, when the terminal interface starts, check() asks the
//      release page of this repository for the newest version. The time of the
//      check is written before the request is made, so a machine that is
//      offline, or a release page that does not answer, is asked again the next
//      day and not at every start.
//   2. A newer version is downloaded in the background by the updater the
//      manual command uses (rafiki/update.ts): the archive is checked against
//      the SHA256SUMS published with the release, and nothing is kept when it
//      does not match. The binary is unpacked into the state directory, not over
//      the running one, and its own SHA-256 is recorded beside it.
//   3. The next start calls applyStaged() before any command is parsed. It
//      recomputes that SHA-256, puts the binary in place with the same rename
//      the manual update uses, and starts the new binary with the same
//      arguments. A staged file that no longer matches is deleted, not run.
//
// Why staged and not replaced straight away, which is what the inherited check
// did for patch releases: a session that is running starts copies of itself,
// and swapping the file under it gives one session two versions.
//
// What it never does. It does not replace a binary a package manager owns
// (npm, Homebrew, winget): those installs get one notice naming the command to
// run. It does not run from a source checkout or a build that is not a
// release. And it does nothing at all when `autoupdate` is false in the global
// configuration or when RAFIKICODE_DISABLE_AUTOUPDATE is set.
//
// Every input is a parameter of check() and applyStaged(), so the tests drive
// both without a network, a clock or a real install (test/rafiki/autoupdate.test.ts).
// upgrade() is the one place the real values are wired in.
import fs from "fs"
import path from "path"
import { createHash } from "crypto"
import { spawnSync } from "child_process"
import semver from "semver"
import { parse as parseJsonc } from "jsonc-parser"
import { Brand } from "@opencode-ai/core/brand/brand"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { InstallationEvent } from "@opencode-ai/schema/installation-event"
import { TuiEvent } from "@opencode-ai/schema/tui-event"
import { RafikiUpdate } from "./update"
import * as ExecTmp from "./exec-tmp"

// At most one check in this many milliseconds.
export const INTERVAL = 24 * 60 * 60 * 1000

export const TITLE = `${Brand.product} update`

const STATE_FILE = "state.json"
const STAGED_FILE = "staged.json"

// What the last check left behind.
export interface State {
  // Epoch milliseconds of the last check that was started, successful or not.
  checkedAt?: number
  // Newest version the last successful check saw.
  latest?: string
  // A version that was staged and could not be put in place. It is not
  // downloaded again; the user is told to update by hand instead.
  failed?: string
}

// A verified binary waiting for the next start.
export interface Staged {
  version: string
  // File name of the binary inside the update directory.
  binary: string
  // SHA-256 of that file, recomputed before it is installed.
  sha256: string
  // The release asset it came out of, and the checksum SHA256SUMS gave for it.
  asset: string
  assetSha256: string
  stagedAt: number
}

export type Notice =
  // autoupdate is "notify": offer the update, download nothing.
  | { kind: "available"; version: string }
  // Downloaded and verified; used from the next start.
  | { kind: "staged"; version: string }
  // This copy is not ours to replace. command is what the user runs instead.
  | { kind: "manual"; version: string; command?: string; reason?: string }

export type CheckOutcome = "disabled" | "not-release" | "throttled" | "failed" | "current" | "notified" | "manual" | "staged"

export interface CheckInput {
  // The `autoupdate` value of the global configuration.
  autoupdate?: boolean | "notify"
  // Version of the running binary.
  current: string
  // True for a compiled release binary. Nothing is ever staged otherwise.
  release: boolean
  // The update directory (state and staged binary).
  dir: string
  now: () => number
  env?: Record<string, string | undefined>
  // Newest published version, without the leading v.
  latest: () => Promise<string>
  // How this copy was installed: "curl" is the installer script.
  method: () => Promise<string>
  execPath: string
  platform?: NodeJS.Platform
  arch?: string
  variant?: string
  fetch?: typeof fetch
  notify: (notice: Notice) => void
}

export type ApplyOutcome = "none" | "skipped" | "disabled" | "discarded" | "refused" | "failed" | "applied"

export interface ApplyInput {
  dir?: string
  // Directory of the global configuration files.
  configDir?: string
  current?: string
  release?: boolean
  env?: Record<string, string | undefined>
  // Arguments after the program name.
  args?: readonly string[]
  execPath?: string
  platform?: NodeJS.Platform
  log?: (line: string) => void
  // Starts the new binary in place of this process. Injected by tests.
  restart?: () => void
  // The executable this process is. Injected by tests, so that none of them
  // depends on the real one.
  running?: RafikiUpdate.Running
}

export function stateDir() {
  return path.join(Global.Path.state, "update")
}

// A compiled binary of the release channel with a real version number. A
// source run executes the runtime, and replacing process.execPath there would
// overwrite the runtime itself.
export function isRelease() {
  return InstallationChannel === "latest" && ExecTmp.compiled() && semver.valid(InstallationVersion) !== null
}

function truthy(value: string | undefined) {
  const text = value?.toLowerCase()
  return text === "1" || text === "true"
}

export function disabledByEnv(env: Record<string, string | undefined> = process.env) {
  return truthy(env[Brand.env.disableAutoupdate]) || truthy(env["OPENCODE_DISABLE_AUTOUPDATE"])
}

// True when the global configuration files set autoupdate to false. Read
// directly and synchronously because applyStaged() runs before the
// configuration service exists; the files and their order are the ones that
// service reads (Brand.globalFiles, later files winning).
export function configuredOff(configDir: string) {
  let value: unknown
  for (const name of Brand.globalFiles) {
    let text: string
    try {
      text = fs.readFileSync(path.join(configDir, name), "utf8")
    } catch {
      continue
    }
    const parsed = parseJsonc(text) as unknown
    if (parsed && typeof parsed === "object" && "autoupdate" in parsed) value = parsed.autoupdate
  }
  return value === false
}

function newer(candidate: string, current: string) {
  const a = semver.valid(candidate)
  const b = semver.valid(current)
  return a !== null && b !== null && semver.gt(a, b)
}

function readJson<T>(file: string): T | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown
    return parsed && typeof parsed === "object" ? (parsed as T) : undefined
  } catch {
    return undefined
  }
}

// Written beside the target and renamed over it, so a reader never sees half a file.
function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function readState(dir: string): State {
  return readJson<State>(path.join(dir, STATE_FILE)) ?? {}
}

export function readStaged(dir: string): Staged | undefined {
  const staged = readJson<Staged>(path.join(dir, STAGED_FILE))
  if (!staged) return undefined
  if (typeof staged.version !== "string" || typeof staged.binary !== "string" || typeof staged.sha256 !== "string") {
    return undefined
  }
  return staged
}

// The staged binary's path. Only the file name is taken from the manifest, so
// a manifest cannot point the install at a file outside the update directory.
function stagedBinary(dir: string, staged: Staged) {
  return path.join(dir, path.basename(staged.binary))
}

// Removes the staged binary and its manifest. The state file stays.
export function discard(dir: string = stateDir()) {
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name === STATE_FILE) continue
    fs.rmSync(path.join(dir, name), { force: true, recursive: true })
  }
}

// SHA-256 of a file, read in pieces: the binary is about 185 MiB.
export function sha256File(file: string) {
  const hash = createHash("sha256")
  const fd = fs.openSync(file, "r")
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (read === 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest("hex")
}

function writable(dir: string) {
  try {
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

// Downloads the release, verifies it against the published SHA256SUMS and
// leaves the binary in the update directory with a manifest. Throws when the
// download or the checksum fails; nothing is left behind in that case.
export async function stage(
  version: string,
  input: Pick<CheckInput, "dir" | "now" | "platform" | "arch" | "variant" | "fetch">,
): Promise<Staged> {
  const platform = input.platform ?? process.platform
  const arch = input.arch ?? process.arch
  const variant = input.variant ?? (await RafikiUpdate.detectVariant(platform, arch))
  const asset = RafikiUpdate.assetName(platform, arch, variant)
  const { bytes, sha256: assetSha256 } = await RafikiUpdate.download(version, asset, { fetch: input.fetch })
  const unpacked = await RafikiUpdate.extract(asset, bytes, platform)
  try {
    discard(input.dir)
    fs.mkdirSync(input.dir, { recursive: true, mode: 0o700 })
    const name = `${Brand.name}-${version}${platform === "win32" ? ".exe" : ""}`
    const target = path.join(input.dir, name)
    fs.copyFileSync(unpacked.binary, `${target}.part`)
    if (platform !== "win32") fs.chmodSync(`${target}.part`, 0o755)
    fs.renameSync(`${target}.part`, target)
    const staged: Staged = {
      version,
      binary: name,
      sha256: sha256File(target),
      asset,
      assetSha256,
      stagedAt: input.now(),
    }
    // The manifest is written last: a binary without one is never installed.
    writeJson(path.join(input.dir, STAGED_FILE), staged)
    return staged
  } catch (cause) {
    discard(input.dir)
    throw cause
  } finally {
    fs.rmSync(unpacked.dir, { recursive: true, force: true })
  }
}

// The daily check. Never throws: an update that could not be fetched is a
// thing to try again tomorrow, not an error to show.
export async function check(input: CheckInput): Promise<CheckOutcome> {
  if (input.autoupdate === false || disabledByEnv(input.env ?? process.env)) {
    // Switched off after something was staged: it must not be installed later.
    discard(input.dir)
    return "disabled"
  }
  if (!input.release) return "not-release"

  const state = readState(input.dir)
  const now = input.now()
  // `now >= checkedAt` so that a clock set back does not silence the check for good.
  if (state.checkedAt !== undefined && now >= state.checkedAt && now - state.checkedAt < INTERVAL) return "throttled"
  try {
    writeJson(path.join(input.dir, STATE_FILE), { ...state, checkedAt: now })
  } catch {
    // A state directory that cannot be written cannot limit the check to once
    // a day, and cannot hold a download either.
    return "failed"
  }

  const latest = await input.latest().catch(() => undefined)
  if (!latest) return "failed"
  writeJson(path.join(input.dir, STATE_FILE), { ...state, checkedAt: now, latest })
  if (!newer(latest, input.current)) return "current"

  if (input.autoupdate === "notify") {
    input.notify({ kind: "available", version: latest })
    return "notified"
  }

  const method = await input.method().catch(() => "unknown")
  if (method !== "curl") {
    input.notify({ kind: "manual", version: latest, command: Brand.upgradeCommand(method) })
    return "manual"
  }
  const installDir = path.dirname(input.execPath)
  if (!writable(installDir)) {
    input.notify({ kind: "manual", version: latest, reason: `${installDir} is not writable by this account` })
    return "manual"
  }
  if (state.failed === latest) {
    input.notify({ kind: "manual", version: latest, reason: `it could not be put in place at ${input.execPath}` })
    return "manual"
  }

  const existing = readStaged(input.dir)
  if (existing?.version === latest && fs.existsSync(stagedBinary(input.dir, existing))) return "staged"

  try {
    await stage(latest, input)
  } catch {
    return "failed"
  }
  input.notify({ kind: "staged", version: latest })
  return "staged"
}

const SELF_MANAGING = ["upgrade", "update", "uninstall"]

// Starts the binary now at process.execPath with the same arguments and exits
// with its status. Same shape as the restart in rafiki/exec-tmp.ts.
function restart(): void {
  const entry = process.argv[1] ?? ""
  const args = ExecTmp.compiled() ? process.argv.slice(2) : [entry, ...process.argv.slice(2)]
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {})
  const run = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: { ...process.env, [Brand.env.updateApplied]: "1" },
  })
  if (run.error) return
  process.exit(run.status ?? 1)
}

// Installs a staged update. Called from src/index.ts before anything is parsed,
// and costs one existsSync when nothing is staged.
export function applyStaged(input: ApplyInput = {}): ApplyOutcome {
  const dir = input.dir ?? stateDir()
  if (!fs.existsSync(path.join(dir, STAGED_FILE))) return "none"
  const env = input.env ?? process.env
  // The process this function started: it is the new version already.
  if (env[Brand.env.updateApplied]) return "none"
  if (!(input.release ?? isRelease())) return "skipped"
  // A command that installs or removes the binary itself is left to do so.
  const command = (input.args ?? process.argv.slice(2)).find((arg) => !arg.startsWith("-"))
  if (command && SELF_MANAGING.includes(command)) return "skipped"
  if (disabledByEnv(env)) return "disabled"
  if (configuredOff(input.configDir ?? Global.Path.config)) {
    discard(dir)
    return "disabled"
  }

  const log = input.log ?? ((line: string) => process.stderr.write(line + "\n"))
  const current = input.current ?? InstallationVersion
  const staged = readStaged(dir)
  if (!staged || !newer(staged.version, current)) {
    // Unreadable, or not newer than what is installed (updated by hand since).
    discard(dir)
    return "discarded"
  }
  const binary = stagedBinary(dir, staged)
  let actual: string | undefined
  try {
    actual = sha256File(binary)
  } catch {
    actual = undefined
  }
  if (actual !== staged.sha256) {
    discard(dir)
    log(
      `${Brand.name}: the downloaded update ${staged.version} no longer matches its checksum, so it was deleted and not installed. Continuing with ${current}.`,
    )
    return "refused"
  }

  // Whatever a caller says about `release`, the default target is only ever a
  // compiled binary: in a run from source process.execPath is the runtime.
  const run = input.running ?? RafikiUpdate.running()
  const execPath = input.execPath ?? (run.compiled ? run.execPath : undefined)
  if (!execPath || RafikiUpdate.refusal(execPath, run)) return "skipped"
  try {
    RafikiUpdate.replaceSync(binary, execPath, input.platform ?? process.platform, run)
  } catch (cause) {
    discard(dir)
    try {
      writeJson(path.join(dir, STATE_FILE), { ...readState(dir), failed: staged.version })
    } catch {
      // The same directory refused the write; the next check tries again.
    }
    const message = cause instanceof Error ? cause.message : String(cause)
    log(
      `${Brand.name}: the downloaded update ${staged.version} could not be put in place at ${execPath} (${message}). Continuing with ${current}; run \`${Brand.name} update\` to install it.`,
    )
    return "failed"
  }
  discard(dir)
  log(`${Brand.name} updated from ${current} to ${staged.version}.`)
  ;(input.restart ?? restart)()
  return "applied"
}

// What a notice looks like in the terminal interface.
export function toastFor(notice: Exclude<Notice, { kind: "available" }>) {
  if (notice.kind === "staged") {
    return {
      title: TITLE,
      message: `Version ${notice.version} was downloaded and will be used the next time you start ${Brand.name}.`,
      variant: "info" as const,
      duration: 10_000,
    }
  }
  const how = notice.command ? `Update with: ${notice.command}` : `Update with: ${Brand.name} update`
  return {
    title: TITLE,
    message: notice.reason
      ? `Version ${notice.version} is available, but ${notice.reason}, so it was not installed. ${how}`
      : `Version ${notice.version} is available. ${how}`,
    variant: "info" as const,
    duration: 15_000,
  }
}

// The start-up check with the real values. Called by the worker of the
// terminal interface one second after it starts (cli/tui/worker.ts).
export async function upgrade(): Promise<CheckOutcome> {
  // Imported here, not at the top: applyStaged() is called while src/index.ts
  // is still starting, and must not pull the configuration service in with it.
  const [{ Config }, { AppRuntime }, { Installation }, { GlobalBus }] = await Promise.all([
    import("@/config/config"),
    import("@/effect/app-runtime"),
    import("@/installation"),
    import("@/bus/global"),
  ])
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  const emit = (type: string, properties: Record<string, unknown>) =>
    GlobalBus.emit("event", { directory: "global", payload: { type, properties } })
  return check({
    autoupdate: config.autoupdate,
    current: InstallationVersion,
    release: isRelease(),
    dir: stateDir(),
    now: Date.now,
    latest: () => RafikiUpdate.latest(),
    method: () => Installation.method(),
    execPath: process.execPath,
    notify(notice) {
      if (notice.kind === "available") {
        emit(InstallationEvent.UpdateAvailable.type, { version: notice.version })
        return
      }
      emit(TuiEvent.ToastShow.type, toastFor(notice))
    },
  })
}

export * as RafikiAutoupdate from "./autoupdate"
