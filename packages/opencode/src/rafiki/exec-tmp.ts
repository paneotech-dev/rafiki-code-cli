// A temporary directory programs can actually run from.
//
// The terminal interface is drawn by a native render library that ships inside
// the compiled binary. Starting it means unpacking that library into the
// temporary directory and loading it with dlopen. A temporary directory mounted
// noexec (the default on a lot of shared and cPanel style hosting) accepts the
// write and then refuses the mapping, which is this, reported by two users on
// the same host:
//
//   Failed to initialize OpenTUI render library: Failed to open library
//   "/tmp/.9adb7abbf6e5efff-00000001.so": /tmp/.9adb7abbf6e5efff-00000001.so:
//   failed to map segment from shared object
//
// Nothing else is wrong on those accounts: the sign in, the key and the gateway
// all work, because only the render library is loaded from a file.
//
// Where the directory comes from, measured against the pinned Bun (1.3.14) and
// the current one (1.4.2): the runtime reads TMPDIR once, while the process
// starts, and unpacks the embedded library into it. So TMPDIR does choose the
// directory, but assigning process.env.TMPDIR from here does not: the copy
// still lands in the directory the process was started with. Pointing the
// unpack somewhere else therefore means starting the binary again with TMPDIR
// set in the child environment, which is what ensure() does, once, guarded by
// Brand.env.tmpdirChecked.
//
// Writable is not the same as executable, so every candidate is tested for
// real: write a small script, make it executable, run it. A directory that
// cannot run it is not used. When none of them can, explain() hands what the
// probe found to the diagnosis layer (rafiki/startup.ts) as the cause of the
// failure, with the step to take: this module is the only thing that knows
// which directories were tried and why each one refused, and that layer owns
// the headline, the exit code, the original error, the cause chain and the
// --print-logs hint, for this failure as for every other.
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { xdgCache } from "xdg-basedir"
import { Brand } from "@opencode-ai/core/brand/brand"

// Why a directory cannot hold the render library. "ok" is the only usable one.
export type Verdict = "ok" | "noexec" | "full" | "unwritable" | "nomem" | "unknown"

export type Attempt = { dir: string; verdict: Verdict }

// Entry path of a compiled binary. Embedded files only exist there, so a source
// run never unpacks anything and never meets this failure.
const bunfs = ["/$bunfs/", "B:/~BUN/"]

export function compiled(argv: readonly string[] = process.argv) {
  const entry = argv[1] ?? ""
  return bunfs.some((prefix) => entry.startsWith(prefix))
}

function errorCode(cause: unknown) {
  return typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : ""
}

function writeVerdict(cause: unknown): Verdict {
  switch (errorCode(cause)) {
    case "ENOSPC":
    case "EDQUOT":
    case "EFBIG":
      return "full"
    case "EROFS":
    case "EACCES":
    case "EPERM":
    case "ENOTDIR":
    case "ENOENT":
      return "unwritable"
    case "ENOMEM":
      return "nomem"
    default:
      return "unknown"
  }
}

function runVerdict(cause: unknown): Verdict {
  switch (errorCode(cause)) {
    // What a noexec mount returns from execve, for root as well.
    case "EACCES":
    case "EPERM":
      return "noexec"
    case "ENOMEM":
      return "nomem"
    default:
      return "unknown"
  }
}

// Writes a tiny script into dir, makes it executable and runs it. The script is
// removed either way. "ok" means a file written there can be executed, which is
// the only thing the render library needs and the only thing a stat cannot tell
// us.
export function probe(dir: string): Verdict {
  const file = path.join(dir, `.${Brand.name}-exec-probe-${process.pid}`)
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
    fs.chmodSync(file, 0o700)
  } catch (cause) {
    return writeVerdict(cause)
  }
  try {
    const run = spawnSync(file, [], { stdio: "ignore" })
    if (run.error) return runVerdict(run.error)
    if (run.status === 0) return "ok"
    // 126 is the shell's own code for "found it, could not run it".
    return run.status === 126 ? "noexec" : "unknown"
  } finally {
    try {
      fs.unlinkSync(file)
    } catch {
      // Nothing to clean up, or nothing we can do about it.
    }
  }
}

function unescapeMountPath(value: string) {
  return value.replace(/\\(040|011|012|134)/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)))
}

function readMountinfo() {
  try {
    return fs.readFileSync("/proc/self/mountinfo", "utf8")
  } catch {
    // Not Linux, or a kernel that does not publish it. Nothing to read.
    return undefined
  }
}

function under(dir: string, point: string) {
  if (point === "/") return true
  return dir === point || dir.startsWith(point.endsWith("/") ? point : point + "/")
}

// Per mount options of the mount dir sits on, from /proc/self/mountinfo: the
// longest mount point that is a prefix of dir wins. undefined when the file
// cannot be read or names no matching mount.
export function mountOptions(dir: string, mountinfo = readMountinfo()): string[] | undefined {
  if (mountinfo === undefined) return undefined
  let best: { point: string; options: string[] } | undefined
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" ")
    if (fields.length < 6) continue
    const point = unescapeMountPath(fields[4])
    if (!under(dir, point)) continue
    if (best && point.length <= best.point.length) continue
    best = { point, options: fields[5].split(",") }
  }
  return best?.options
}

// True when the mount is flagged noexec, false when it is not, undefined when
// the mount table says nothing. This is the cheap read that decides whether to
// probe at all: on a healthy machine it is one small file and no subprocess.
export function mountedNoexec(dir: string, mountinfo = readMountinfo()) {
  const options = mountOptions(dir, mountinfo)
  return options === undefined ? undefined : options.includes("noexec")
}

// Directories to fall back to, in order, following the cache convention for
// files this product unpacks for itself (Global.Path.cache, XDG_CACHE_HOME
// aware) and then the config directory, which a home that allows execution at
// all will accept.
export function candidates(input: { cache: string; config: string }) {
  return [path.join(input.cache, "tmp"), path.join(input.config, "tmp")]
}

// Probes dirs in order and stops at the first usable one. Every result is kept
// so the error message can name what was tried and why each one failed. check is
// the probe, taken as an argument so the selection can be tested on a machine
// where a noexec mount cannot be created.
export function choose(dirs: readonly string[], tried: Attempt[] = [], check: (dir: string) => Verdict = probe) {
  for (const dir of dirs) {
    if (tried.some((attempt) => attempt.dir === dir)) continue
    const verdict = check(dir)
    tried.push({ dir, verdict })
    if (verdict === "ok") return { dir, tried }
  }
  return { dir: undefined, tried }
}

const reasons: Record<Verdict, string> = {
  ok: "usable",
  noexec: 'mounted "noexec", so a file written there cannot be run',
  full: "full, there is no space left for the file",
  unwritable: "not writable",
  nomem: "out of memory while testing it",
  unknown: "could not be tested",
}

// The first verdict present, in the order a person would want explained.
function primary(tried: readonly Attempt[]): Verdict {
  const order: Verdict[] = ["noexec", "full", "unwritable", "nomem", "unknown"]
  return order.find((verdict) => tried.some((attempt) => attempt.verdict === verdict)) ?? "unknown"
}

// What a blocked user reads instead of the dlopen string: what failed, every
// directory tried and why each one refused, and that their account is not the
// problem. This is the cause of the diagnosis, so it opens the way every other
// cause does; step() is the command half, and the headline and the original
// error belong to the layer that prints them (rafiki/startup.ts).
export function message(tried: readonly Attempt[]) {
  const lines = [
    "Probable cause: no temporary directory on this machine will run a file.",
    "",
    `${Brand.product} draws its terminal interface with a small library that travels inside the ${Brand.name} binary. Starting it means unpacking that library into a temporary directory and then running it from there, and every directory tried refuses one of those two steps.`,
    "",
    "Directories tried:",
    ...tried.map((attempt) => `  ${attempt.dir} (${reasons[attempt.verdict]})`),
    "",
  ]
  switch (primary(tried)) {
    case "noexec":
      lines.push(
        'A directory mounted "noexec" accepts the file and then will not run it. That is a setting on this machine, not a problem with your account: your sign in and your key are fine.',
      )
      break
    case "full":
      lines.push("The temporary directory is full. Free some space there and start again.")
      break
    case "unwritable":
      lines.push("No temporary directory could be written to. Check the permissions on the directories above.")
      break
    case "nomem":
      lines.push(
        "This account ran out of memory while the directory was being tested. Try again with fewer programs running.",
      )
      break
    default:
      lines.push("Why the directories cannot be used could not be determined on this machine.")
  }
  return lines.join("\n")
}

// The step for that same case: one directory the user can point at themselves,
// and one line to send whoever runs the machine. The fallback directories have
// already been tried by the time this prints, which is why it does not offer
// one of them.
export function step() {
  return [
    `If you know a directory on this machine that programs are allowed to run from, point ${Brand.name} at it:`,
    "",
    `  TMPDIR=/that/directory ${Brand.name}`,
    "",
    "Otherwise ask whoever runs this server for one. This is the line to send them:",
    "",
    `  "${Brand.name} needs a directory I can write a file to and then execute. Please give me one that is not mounted noexec, or allow execution under my home directory."`,
  ].join(os.EOL)
}

// True for the render library failing to load, in any of the shapes the runtime
// reports it: the mapping refused on a noexec mount, or the unpack failing
// first and leaving the in binary path to be opened directly.
export function isRenderLibFailure(input: unknown) {
  const text = input instanceof Error ? input.message : typeof input === "string" ? input : ""
  if (!text) return false
  if (/failed to map segment from shared object/i.test(text)) return true
  if (/Failed to initialize OpenTUI render library/i.test(text)) return true
  return /cannot open shared object file/i.test(text) && bunfs.some((prefix) => text.includes(prefix))
}

// The same roots global.ts builds its cache and config paths from, read here
// rather than imported so this module stays free of the directory creation
// global.ts does as it loads.
function roots() {
  return { cache: path.join(xdgCache ?? path.join(os.homedir(), ".cache"), Brand.dir), config: Brand.configDir() }
}

// The library the failure names, when it names one, so the cause can say which
// file it was instead of leaving the user to find it in a dlopen string.
function libraryFile(input: unknown) {
  const text = input instanceof Error ? input.message : typeof input === "string" ? input : ""
  return text.match(/(?:[A-Za-z]:)?[\\/][^\s"'`:,()]+\.(?:so|dylib|dll)(?:\.\d+)*/)?.[0]
}

// The render library failed, and yet a file can be written to dir and run from
// it, so noexec is not what happened. The causes left are ones a probe cannot
// tell apart: a library built for another machine or another C library, or the
// account running out of memory while it was mapped. Say which they are, and do
// not list directories that are not at fault. The original words are kept by the
// layer that prints this, as the "Original error:" line (rafiki/startup.ts).
function otherCause(input: unknown, dir: string) {
  const file = libraryFile(input)
  return [
    `Probable cause: not the temporary directory. ${dir} can hold a file and then run it, so the usual cause on shared hosting, a temporary directory mounted "noexec", is not this${file ? `, and yet ${file} could not be mapped` : ""}.`,
    "",
    "What is left:",
    "  a build for another kind of machine, or for a newer C library than this one has (check yours with: ldd --version)",
    "  this account reaching its memory limit while the library was loaded",
    `  too little free space in ${dir}`,
    "",
    "Either way this is not your account: your sign in and your key are fine, because only the terminal interface loads a library from a file.",
  ].join("\n")
}

// The step for that case: nothing here is fixed by a different directory, so it
// sends the user to the self check first, and the report way out carries the
// address to report it at (rafiki/startup.ts).
function selfCheck() {
  return `Start with the self check, in case it names the problem:${os.EOL}  ${Brand.name} doctor`
}

// What the diagnosis layer prints for a render library failure: the cause, in
// the words of whatever the probe found, and the step that follows from it.
// report is true when the failure is worth sending to us rather than to whoever
// runs the machine.
export interface Detail {
  cause: string
  step: string
  report?: boolean
}

// The detail for a render library failure, or undefined when this is not that
// failure, in which case the diagnosis layer falls back to what the error text
// alone can tell it. Probes again here rather than carrying state from ensure(),
// so the reasons printed are the ones true at the moment of the failure, and so
// a failure that is not about the temporary directory is not blamed on it. check
// is the probe, taken as an argument so the no-directory-works report can be
// tested on a machine where a noexec mount cannot be created.
export function explain(
  input: unknown,
  dirs: readonly string[] = candidates(roots()),
  check: (dir: string) => Verdict = probe,
): Detail | undefined {
  if (!isRenderLibFailure(input)) return undefined
  const current = process.env["TMPDIR"] || os.tmpdir()
  const picked = choose([current, ...dirs], [], check)
  if (!picked.dir) return { cause: message(picked.tried), step: step() }
  return { cause: otherCause(input, picked.dir), step: selfCheck(), report: true }
}

// Starts this binary again with TMPDIR pointing at dir and exits with whatever
// the child exits with. Returns instead when the child could not be started at
// all, and the caller then carries on in this process so that the render library
// failure explains itself.
function restart(dir: string): void {
  const entry = process.argv[1] ?? ""
  const args = compiled() ? process.argv.slice(2) : [entry, ...process.argv.slice(2)]
  // The terminal signals the whole foreground group, so the child gets its own
  // interrupt; this process only has to survive long enough to pass on the exit
  // code instead of dying first and orphaning the child on the terminal.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {})
  const run = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: { ...process.env, TMPDIR: dir, [Brand.env.tmpdirChecked]: "1" },
  })
  if (run.error) return
  process.exit(run.status ?? 1)
}

// Called once from src/index.ts before anything is parsed. Does nothing at all
// unless this is a compiled binary whose temporary directory is flagged noexec
// and really cannot run a file, which is the only case that needs fixing.
export function ensure() {
  if (process.env[Brand.env.tmpdirChecked]) return
  if (!compiled()) return
  const current = process.env["TMPDIR"] || os.tmpdir()
  if (mountedNoexec(current) !== true) return
  // The mount table said noexec, which is cheap to read and sometimes wrong, so
  // the directory is tested before anything is done about it.
  const verdict = probe(current)
  if (verdict === "ok") return
  const picked = choose(candidates(roots()), [{ dir: current, verdict }])
  if (!picked.dir) return
  restart(picked.dir)
}
