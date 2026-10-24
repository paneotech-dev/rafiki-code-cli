// The project's dev server, for the screenshot tool (tool/screenshot.ts):
// started from the package.json scripts in the background when the tool is
// asked to, the address read from what it prints, and stopped when this
// process ends. One server per folder; a second call reuses it.
import fs from "fs"
import path from "path"
import { spawn, spawnSync, type ChildProcess } from "child_process"

// Scripts tried, in order.
export const SCRIPTS = ["dev", "start", "serve", "preview"] as const

export interface Plan {
  dir: string
  script: string
  command: string[]
  display: string
}

// The package manager of the folder, from its lock file.
export function packageManager(dir: string, exists: (file: string) => boolean = fs.existsSync) {
  if (exists(path.join(dir, "bun.lock")) || exists(path.join(dir, "bun.lockb"))) return "bun"
  if (exists(path.join(dir, "pnpm-lock.yaml"))) return "pnpm"
  if (exists(path.join(dir, "yarn.lock"))) return "yarn"
  return "npm"
}

// How the dev server of a folder is started, or undefined when its
// package.json has none of the scripts above.
export function plan(dir: string, read: (file: string) => string | undefined = readText): Plan | undefined {
  const text = read(path.join(dir, "package.json"))
  if (!text) return undefined
  const pkg = (() => {
    try {
      return JSON.parse(text) as { scripts?: Record<string, unknown> }
    } catch {
      return undefined
    }
  })()
  const script = SCRIPTS.find((name) => typeof pkg?.scripts?.[name] === "string")
  if (!script) return undefined
  const manager = packageManager(dir, (file) => read(file) !== undefined)
  const command = [manager, "run", script]
  return { dir, script, command, display: command.join(" ") }
}

function readText(file: string) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

// The first local address in the output of a dev server.
export function address(output: string) {
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "")
  const match = plain.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{2,5}\/?[^\s"'`]*/)
  return match ? match[0].replace("0.0.0.0", "localhost").replace(/[).,;]+$/, "") : undefined
}

interface Server {
  child: ChildProcess
  url: Promise<string>
}

const servers = new Map<string, Server>()

function kill(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    return
  }
  try {
    // The server runs in a process group of its own: stop the whole group.
    process.kill(-child.pid, "SIGTERM")
  } catch {
    child.kill("SIGTERM")
  }
}

let hooked = false
function hookExit() {
  if (hooked) return
  hooked = true
  process.once("exit", stopAll)
}

// Starts the dev server of the folder, or returns the one already running.
export function start(input: Plan & { timeoutMs?: number }): Promise<string> {
  const running = servers.get(input.dir)
  if (running && running.child.exitCode === null) return running.url
  hookExit()
  const timeoutMs = input.timeoutMs ?? 90_000
  const child = spawn(input.command[0]!, input.command.slice(1), {
    cwd: input.dir,
    env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0", CI: process.env.CI ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
    shell: process.platform === "win32",
  })
  const url = new Promise<string>((resolve, reject) => {
    let output = ""
    const timer = setTimeout(() => {
      fail(`${input.display} printed no local address within ${Math.round(timeoutMs / 1000)}s`)
    }, timeoutMs)
    const fail = (reason: string) => {
      clearTimeout(timer)
      kill(child)
      servers.delete(input.dir)
      const tail = output.trim().split("\n").slice(-8).join("\n")
      reject(new Error(tail ? `${reason}. Last output:\n${tail}` : reason))
    }
    const read = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-20_000)
      const found = address(output)
      if (!found) return
      clearTimeout(timer)
      child.stdout?.off("data", read)
      child.stderr?.off("data", read)
      resolve(found)
    }
    child.stdout?.on("data", read)
    child.stderr?.on("data", read)
    child.on("error", (error) => fail(`${input.display} could not be started (${error.message})`))
    child.on("exit", (code) => fail(`${input.display} exited with code ${code}`))
  })
  // Wait until the address answers, not only until it is printed.
  const ready = url.then(async (found) => {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const ok = await fetch(found, { signal: AbortSignal.timeout(3_000) }).then(
        () => true,
        () => false,
      )
      if (ok) return found
      await Bun.sleep(300)
    }
    return found
  })
  ready.catch(() => {})
  servers.set(input.dir, { child, url: ready })
  return ready
}

export function stop(dir: string) {
  const server = servers.get(dir)
  if (!server) return false
  servers.delete(dir)
  kill(server.child)
  return true
}

export function stopAll() {
  for (const dir of [...servers.keys()]) stop(dir)
}

export function runningIn(dir: string) {
  const server = servers.get(dir)
  return server !== undefined && server.child.exitCode === null
}
