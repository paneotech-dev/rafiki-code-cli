// What a package manager actually offers, and which copy a new shell runs.
// Fork only.
//
// Two things found on real machines:
//
//   1. npm, Homebrew and winget are published by the release workflow only when
//      their tokens are set, so they can lag behind the GitHub release. `update`
//      used to read the newest version from GitHub, run `brew upgrade` (which
//      did nothing) and print "Upgrade complete"; winget was asked for a version
//      it did not have and failed with a bare exit code. offered() asks the
//      channel itself (npm view, brew info, winget show), so the command and the
//      daily check can say plainly when it is behind and give the installer line.
//
//   2. An older copy earlier on PATH keeps answering to the name after an
//      update. newShell() asks a new shell which file it would run (command -v,
//      or Get-Command on Windows with the PATH a new terminal gets), and
//      removal() names the command that removes the other copy, with the same
//      rules as the installer's check_shadow (install/install.sh, install.ps1).
//
// Every command goes through a Run function, so the tests stub the package
// managers and the shell (test/rafiki/channels.test.ts).
import fs from "fs"
import path from "path"
import { spawn } from "child_process"
import semver from "semver"
import { Brand } from "@opencode-ai/core/brand/brand"

export interface Result {
  code: number
  stdout: string
  stderr: string
}

export type Run = (cmd: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<Result>

const DEFAULT_TIMEOUT_MS = 60_000

// Runs a command and collects its output. Never throws: a command that cannot
// be started is a result with code 127 and the reason on stderr.
export const run: Run = (cmd, opts = {}) =>
  new Promise((resolve) => {
    const [file, ...args] = cmd
    // npm and pnpm are .cmd scripts on Windows, which only start through the
    // shell there. The arguments are fixed strings of this module.
    const shell = process.platform === "win32" && /^(npm|pnpm)$/i.test(file)
    let stdout = ""
    let stderr = ""
    let done = false
    const finish = (result: Result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: opts.env ?? process.env,
        windowsHide: true,
        shell,
      })
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: 124, stdout, stderr: stderr + `\n${file} did not finish in time` })
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()))
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()))
    child.on("error", (err) => finish({ code: 127, stdout, stderr: stderr + err.message }))
    child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr }))
  })

export const MANAGERS = ["npm", "pnpm", "bun", "brew", "winget"] as const

export function isManager(method: string) {
  return (MANAGERS as readonly string[]).includes(method)
}

// The channel's name as a person knows it.
export function label(method: string) {
  if (method === "brew") return "Homebrew"
  if (method === "pnpm" || method === "bun") return "npm"
  return method
}

// The stable version in `brew info --json=v2` output.
export function parseBrew(stdout: string): string | undefined {
  try {
    const data = JSON.parse(stdout) as { formulae?: Array<{ versions?: { stable?: string } }> }
    return clean(data.formulae?.[0]?.versions?.stable)
  } catch {
    return undefined
  }
}

// The "Version: x.y.z" line of `winget show`, in whatever language winget
// speaks the label is the first word before a colon, so any "<word>: <semver>"
// line right after the "Found" header is taken; the English label first.
export function parseWinget(stdout: string): string | undefined {
  const english = stdout.match(/^\s*Version:\s*v?(\S+)\s*$/m)
  if (english) return clean(english[1])
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*[^:\s]+:\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/)
    if (m) return clean(m[1])
  }
  return undefined
}

function clean(version: string | undefined) {
  if (!version) return undefined
  const v = version.trim().replace(/^v/, "")
  return semver.valid(v) ? v : undefined
}

// The newest version the channel this copy came from would install now, or
// undefined when it cannot be read (the command failed, or the package is not
// there). refresh: update Homebrew's copy of the tap first, which `upgrade`
// does anyway; the daily check reads what is already on the machine.
export async function offered(
  method: string,
  opts: { run?: Run; refresh?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<string | undefined> {
  const exec: Run = (cmd, o = {}) => (opts.run ?? run)(cmd, { env: opts.env, ...o })
  switch (method) {
    case "npm":
    case "pnpm":
    case "bun": {
      const npm = await exec(["npm", "view", Brand.npm.meta, "version"])
      if (npm.code === 0 && clean(npm.stdout)) return clean(npm.stdout)
      if (method === "pnpm") {
        const pnpm = await exec(["pnpm", "view", Brand.npm.meta, "version"])
        if (pnpm.code === 0) return clean(pnpm.stdout)
      }
      return undefined
    }
    case "brew": {
      if (opts.refresh) {
        await exec(["brew", "tap", Brand.brew.tap])
        await exec(["brew", "update", "--quiet"], { timeoutMs: 300_000 })
      }
      const info = await exec(["brew", "info", "--json=v2", Brand.brew.formula])
      return info.code === 0 ? parseBrew(info.stdout) : undefined
    }
    case "winget": {
      const show = await exec([
        "winget",
        "show",
        "--id",
        Brand.winget.id,
        "--exact",
        "--accept-source-agreements",
        "--disable-interactivity",
      ])
      return show.code === 0 ? parseWinget(show.stdout) : undefined
    }
    default:
      return undefined
  }
}

// `<file> --version`: the first version on the first line of stdout.
export async function versionOf(file: string, opts: { run?: Run; env?: NodeJS.ProcessEnv } = {}): Promise<string | undefined> {
  const result = await (opts.run ?? run)([file, "--version"], { timeoutMs: 15_000, env: opts.env })
  if (result.code !== 0) return undefined
  const first = result.stdout.trim().split(/\r?\n/)[0] ?? ""
  return clean(first.split(/\s+/).find((word) => clean(word)))
}

// The file a package manager installs the command as, for the comparison with
// what a new shell finds. undefined when the package manager cannot say.
export async function managedPath(
  method: string,
  opts: { run?: Run; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; execPath?: string } = {},
): Promise<string | undefined> {
  const exec = opts.run ?? run
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const p = platform === "win32" ? path.win32 : path.posix
  const out = async (cmd: string[]) => {
    const result = await exec(cmd, { timeoutMs: 15_000, env: opts.env })
    const line = result.stdout.trim().split(/\r?\n/).pop()?.trim()
    return result.code === 0 && line ? line : undefined
  }
  switch (method) {
    case "curl":
      return opts.execPath
    case "npm": {
      const prefix = await out(["npm", "prefix", "-g"])
      if (!prefix) return undefined
      return platform === "win32" ? p.join(prefix, `${Brand.name}.cmd`) : p.join(prefix, "bin", Brand.name)
    }
    case "pnpm": {
      const dir = await out(["pnpm", "bin", "-g"])
      return dir ? p.join(dir, platform === "win32" ? `${Brand.name}.cmd` : Brand.name) : undefined
    }
    case "bun": {
      const dir = await out(["bun", "pm", "bin", "-g"])
      return dir ? p.join(dir, platform === "win32" ? `${Brand.name}.exe` : Brand.name) : undefined
    }
    case "brew": {
      const prefix = await out(["brew", "--prefix"])
      return prefix ? p.join(prefix, "bin", Brand.name) : undefined
    }
    case "winget": {
      const local = env["LOCALAPPDATA"]
      return local ? p.join(local, "Microsoft", "WinGet", "Links", `${Brand.name}.exe`) : undefined
    }
    default:
      return undefined
  }
}

// The first file named `name` on a PATH, the way a shell searches it.
export function onPath(
  name: string,
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): string | null {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const value = env["PATH"] ?? env["Path"] ?? ""
  const sep = platform === "win32" ? ";" : ":"
  const exts =
    platform === "win32" ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase()) : [""]
  for (const dir of value.split(sep)) {
    if (!dir) continue
    for (const ext of exts) {
      const file = (platform === "win32" ? path.win32 : path.posix).join(dir, name + ext)
      try {
        const stat = fs.statSync(file)
        if (!stat.isFile()) continue
        if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK)
        return file
      } catch {
        continue
      }
    }
  }
  return null
}

const MARK = `__${Brand.name}_path__`

// Which file a new shell runs for the command: the account's login shell
// started as a new terminal starts it (POSIX), or Get-Command with the PATH a
// new terminal gets from the registry (Windows). When the shell cannot be
// asked, this process's PATH is searched instead.
export async function newShell(
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; run?: Run; name?: string } = {},
): Promise<string | null> {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const name = opts.name ?? Brand.name
  const exec = opts.run ?? run
  let cmd: string[]
  if (platform === "win32") {
    cmd = [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'); $c = Get-Command ${name} -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; Write-Output ('${MARK}' + $c.Source)`,
    ]
  } else {
    const shell = env["SHELL"] || "/bin/sh"
    const fish = path.basename(shell) === "fish"
    const script = fish
      ? `printf '\\n${MARK}%s\\n' (command -v ${name})`
      : `printf '\\n${MARK}%s\\n' "$(command -v ${name})"`
    cmd = [shell, "-i", "-l", "-c", script]
  }
  const result = await exec(cmd, { timeoutMs: 10_000, env: env as NodeJS.ProcessEnv })
  const line = result.stdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith(MARK))
  if (line !== undefined) {
    const found = line.slice(MARK.length).trim()
    return found || null
  }
  return onPath(name, { env, platform })
}

export function realPath(file: string) {
  try {
    return fs.realpathSync.native(file)
  } catch {
    return path.resolve(file)
  }
}

export function sameFile(a: string, b: string) {
  const ra = realPath(a)
  const rb = realPath(b)
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb
}

function writable(dir: string) {
  try {
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

// How a copy was installed and the command that removes it: the rules of the
// installer's check_shadow (install.sh) and its PowerShell twin (install.ps1).
export function removal(file: string, platform: NodeJS.Platform = process.platform) {
  const real = realPath(file)
  const lower = real.toLowerCase()
  if (lower.includes("node_modules") || /[\\/]npm[\\/]/.test(lower))
    return { how: "installed with npm", remove: `npm uninstall -g ${Brand.npm.meta}` }
  if (/\/cellar\/|homebrew|linuxbrew/.test(lower)) return { how: "installed with Homebrew", remove: `brew uninstall ${Brand.brew.formula}` }
  if (/[\\/]microsoft[\\/]winget[\\/]/.test(lower)) return { how: "installed with winget", remove: `winget uninstall --id ${Brand.winget.id} --exact` }
  if (lower.includes("scoop")) return { how: "installed with scoop", remove: `scoop uninstall ${Brand.name}` }
  if (platform === "win32") return { how: "an older copy", remove: `Remove-Item "${file}"` }
  const sudo = writable(path.dirname(file)) ? "" : "sudo "
  return { how: "an older copy", remove: `${sudo}rm '${file}'` }
}

// The line that puts a directory first on PATH, for this terminal and the
// startup file of the shell in use.
export function pathFix(dir: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env) {
  if (platform === "win32")
    return `[Environment]::SetEnvironmentVariable('Path', '${dir};' + [Environment]::GetEnvironmentVariable('Path','User'), 'User')`
  const shell = path.basename(env["SHELL"] ?? "")
  if (shell === "fish") return `fish_add_path ${dir}`
  const rc = shell === "zsh" ? "~/.zshrc" : shell === "bash" ? "~/.bashrc" : "~/.profile"
  return `echo 'export PATH=${dir}:$PATH' >> ${rc}`
}

// What to say when a new shell would run another file than the one just
// updated. Empty when it runs that file.
export function shadowLines(input: {
  first: string | null
  updated: string
  firstVersion?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}): string[] {
  const platform = input.platform ?? process.platform
  const dir = (platform === "win32" ? path.win32 : path.posix).dirname(input.updated)
  if (!input.first) {
    return [
      `A new terminal does not find ${Brand.name} on PATH; the updated copy is ${input.updated}.`,
      `To put it on PATH: ${pathFix(dir, platform, input.env)}`,
    ]
  }
  if (sameFile(input.first, input.updated)) return []
  const { how, remove } = removal(input.first, platform)
  const version = input.firstVersion ? `, version ${input.firstVersion}` : ""
  return [
    `A new terminal runs ${input.first} (${how}${version}), not ${input.updated}, which was just updated.`,
    `To remove the other copy: ${remove}`,
    `Or put ${dir} first on PATH: ${pathFix(dir, platform, input.env)}`,
  ]
}

export * as RafikiChannels from "./channels"
