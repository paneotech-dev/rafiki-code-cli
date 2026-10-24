// Runs the parallel attempts of rafiki/attempts.ts: one copy of the project
// and one `rafikicode run --format json` per attempt, then the best change
// applied to the real working tree, and every copy and process removed.
import fs from "fs"
import os from "os"
import path from "path"
import { spawn, spawnSync, type ChildProcess } from "child_process"
import * as Account from "@opencode-ai/core/brand/account"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as ExecTmp from "./exec-tmp"
import * as Tpm from "./tpm"
import * as Attempts from "./attempts"

// Dependency folders linked into each copy instead of copied.
export const LINKED = new Set(["node_modules", "vendor", ".venv", "venv", "bower_components"])
// Left out of a copy of a project that is not a git repository.
const SKIPPED = new Set([".git", "__pycache__", ".pytest_cache", ".mypy_cache", ".next", ".turbo"])
// Ignored files at the top of a repository copied into each worktree (.env and the like), up to this size.
const SMALL_FILE = 256 * 1024
const COPY_LIMIT = 50_000
const STOP_GRACE_MS = 10_000

export interface Workspace {
  // The folder the attempt runs in (the project folder inside the copy).
  dir: string
  // The root of the copy, where the patch is taken.
  root: string
  // The tree the attempt started from.
  base: string
  // Links to dependency folders, relative to root.
  links: string[]
  mode: "worktree" | "copy"
}

export interface Project {
  // The folder the task runs in.
  dir: string
  // The git top level, when the project is in a repository with a commit.
  top?: string
}

type Git = (args: string[], cwd: string, input?: { env?: Record<string, string>; stdin?: string | Buffer }) => {
  ok: boolean
  out: string
  err: string
}

export const git: Git = (args, cwd, input) => {
  const run = spawnSync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...input?.env },
    input: input?.stdin,
    maxBuffer: 256 * 1024 * 1024,
  })
  return {
    ok: run.status === 0,
    out: run.stdout?.toString("utf8") ?? "",
    err: (run.stderr?.toString("utf8") ?? run.error?.message ?? "").trim(),
  }
}

export function hasGit() {
  return git(["--version"], os.tmpdir()).ok
}

export function project(dir: string): Project {
  const top = git(["rev-parse", "--show-toplevel"], dir)
  if (!top.ok) return { dir }
  if (!git(["rev-parse", "--verify", "-q", "HEAD"], dir).ok) return { dir }
  return { dir, top: fs.realpathSync(top.out.trim()) }
}

const linkType = process.platform === "win32" ? "junction" : "dir"

function link(target: string, at: string) {
  fs.mkdirSync(path.dirname(at), { recursive: true })
  fs.symlinkSync(target, at, linkType)
}

// Never part of an attempt's change: caches the checks leave behind, and the
// project memory an attempt writes about itself.
export const NOT_CHANGES = ["**/__pycache__/**", "**/*.pyc", "**/.pytest_cache/**", ".rafiki/memory/**"]
const exclude = (links: string[]) => [
  ...links.map((item) => `:(exclude)${item}`),
  ...NOT_CHANGES.map((item) => `:(exclude,glob)${item}`),
]

// Stage everything of the copy but the links, and give the tree.
function tree(root: string, links: string[]) {
  const add = git(["add", "-A", "--", ".", ...exclude(links)], root)
  if (!add.ok) throw new Error(`git add failed: ${add.err}`)
  const written = git(["write-tree"], root)
  if (!written.ok) throw new Error(`git write-tree failed: ${written.err}`)
  return written.out.trim()
}

// A git worktree of HEAD with the uncommitted changes and the untracked files
// of the real one.
function worktree(input: Project & { top: string }, at: string): Workspace {
  const added = git(["worktree", "add", "--detach", "--quiet", at, "HEAD"], input.top)
  if (!added.ok) throw new Error(`git worktree add failed: ${added.err}`)
  const links: string[] = []
  const pending = git(["diff", "HEAD", "--binary"], input.top)
  if (pending.ok && pending.out.trim()) {
    const applied = git(["apply", "--binary", "--whitespace=nowarn", "-"], at, { stdin: pending.out })
    if (!applied.ok) throw new Error(`the uncommitted changes did not apply to the copy: ${applied.err}`)
  }
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], input.top).out.split("\0").filter(Boolean)
  for (const file of untracked) {
    const from = path.join(input.top, file)
    const to = path.join(at, file)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true })
  }
  const ignored = git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], input.top)
    .out.split("\0")
    .filter(Boolean)
  for (const entry of ignored) {
    const relative = entry.replace(/\/$/, "")
    const from = path.join(input.top, relative)
    if (LINKED.has(path.basename(relative)) && entry.endsWith("/")) {
      if (fs.existsSync(path.join(at, relative))) continue
      link(from, path.join(at, relative))
      links.push(relative.split(path.sep).join("/"))
      continue
    }
    // Small ignored files at the top (.env, local settings) the checks may need.
    if (!relative.includes("/") && !entry.endsWith("/")) {
      const stat = fs.lstatSync(from, { throwIfNoEntry: false })
      if (stat?.isFile() && stat.size <= SMALL_FILE) fs.copyFileSync(from, path.join(at, relative))
    }
  }
  const dir = path.join(at, path.relative(input.top, fs.realpathSync(input.dir)))
  return { dir, root: at, base: tree(at, links), links, mode: "worktree" }
}

// A copy of a project that is not a git repository, with a repository of its
// own to take the patch from.
function copy(input: Project, at: string): Workspace {
  const links: string[] = []
  let count = 0
  fs.mkdirSync(at, { recursive: true })
  fs.cpSync(input.dir, at, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => {
      const relative = path.relative(input.dir, source)
      if (!relative) return true
      const name = path.basename(source)
      if (SKIPPED.has(name)) return false
      if (LINKED.has(name) && fs.lstatSync(source).isDirectory()) {
        link(source, path.join(at, relative))
        links.push(relative.split(path.sep).join("/"))
        return false
      }
      if (++count > COPY_LIMIT) throw new Error(`the project has more than ${COPY_LIMIT} files to copy`)
      return true
    },
  })
  const init = git(["init", "-q"], at)
  if (!init.ok) throw new Error(`git init failed: ${init.err}`)
  fs.writeFileSync(path.join(at, ".git", "info", "exclude"), [...SKIPPED, "*.pyc", ".DS_Store", ""].join("\n"))
  return { dir: at, root: at, base: tree(at, links), links, mode: "copy" }
}

export function prepare(input: Project, at: string): Workspace {
  return input.top ? worktree({ ...input, top: input.top }, at) : copy(input, at)
}

// The change of an attempt: the patch from its start, and its size.
export function change(workspace: Workspace) {
  const base = workspace.base
  tree(workspace.root, workspace.links)
  const numstat = git(["diff", "--cached", "--numstat", base, "--", ".", ...exclude(workspace.links)], workspace.root)
  const diff = { files: 0, added: 0, removed: 0 }
  for (const row of numstat.out.split("\n")) {
    const [added, removed] = row.split("\t")
    if (added === undefined || removed === undefined) continue
    diff.files++
    diff.added += Number(added) || 0
    diff.removed += Number(removed) || 0
  }
  const patch = diff.files
    ? git(["diff", "--cached", "--binary", "--full-index", base, "--", ".", ...exclude(workspace.links)], workspace.root).out
    : ""
  return { diff, patch }
}

// The winner's patch applied to the real tree: at the git top level, or in the
// project folder of a project that is not a repository.
export function apply(input: Project, patch: string): { ok: true } | { ok: false; error: string } {
  const cwd = input.top ?? input.dir
  const args = ["apply", "--binary", "--whitespace=nowarn"]
  const check = git([...args, "--check", "-"], cwd, { stdin: patch })
  if (check.ok) {
    const done = git([...args, "-"], cwd, { stdin: patch })
    return done.ok ? { ok: true } : { ok: false, error: done.err.split("\n")[0] || "git apply failed" }
  }
  if (input.top) {
    const merged = git([...args, "--3way", "-"], cwd, { stdin: patch })
    if (merged.ok) return { ok: true }
  }
  return { ok: false, error: check.err.split("\n")[0] || "the working tree changed while the attempts ran" }
}

export function remove(input: Project, workspace: Workspace) {
  // The links go first, so nothing below them is ever touched.
  for (const item of workspace.links) {
    try {
      fs.unlinkSync(path.join(workspace.root, item))
    } catch {
      try {
        fs.rmdirSync(path.join(workspace.root, item))
      } catch {}
    }
  }
  if (workspace.mode === "worktree" && input.top) git(["worktree", "remove", "--force", workspace.root], input.top)
  fs.rmSync(workspace.root, { recursive: true, force: true })
  if (input.top) git(["worktree", "prune"], input.top)
}

// The command line of a child run: the binary itself, or the runtime and the
// entry file in a run from source (started from the package folder, where the
// runtime finds its settings).
export function self(args: string[], dir: string, argv: readonly string[] = process.argv, execPath = process.execPath) {
  if (ExecTmp.compiled(argv)) return { file: execPath, args, cwd: dir }
  const entry = argv[1] ?? ""
  return { file: execPath, args: [entry, ...args], cwd: path.dirname(path.dirname(entry)) }
}

export function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"])
    else process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {}
  }
}

export interface Options {
  dir: string
  task: string
  count: number
  // The model the person chose (provider/model), or undefined for rafiki-fast.
  model?: string
  pro?: boolean
  auto: boolean
  variant?: string
  agent?: string
  // Called as each attempt starts and ends.
  onStart?: (index: number, tier: string, approach: string) => void
  onEnd?: (outcome: Attempts.Outcome) => void
  // For tests.
  spawnRun?: (args: string[], dir: string) => ChildProcess
  tpm?: number
  readSpend?: () => Promise<number | undefined>
  staggerMs?: number
  env?: Record<string, string | undefined>
}

async function keySpend() {
  const result = await Account.keyInfo({ timeoutMs: 5_000 }).catch(() => undefined)
  return result?.ok ? result.info.spend : undefined
}

const live = new Set<ChildProcess>()
const workspaces = new Map<string, { input: Project; workspace: Workspace }>()

// Stops every child and removes every copy: the end of a run, a signal, an error.
export function cleanup() {
  for (const child of live) stop(child, "SIGKILL")
  live.clear()
  for (const [key, item] of workspaces) {
    try {
      remove(item.input, item.workspace)
    } catch {}
    workspaces.delete(key)
  }
}

function runOne(options: Options, workspace: Workspace, index: number, tier: string): Promise<{ lines: string[]; code: number | null; stderr: string }> {
  const args = ["run", "--format", "json", "--model", tier, "--title", `attempt ${index + 1}`]
  if (options.auto) args.push("--auto")
  if (options.variant) args.push("--variant", options.variant)
  if (options.agent) args.push("--agent", options.agent)
  args.push("--dir", workspace.dir, "--", Attempts.prompt(options.task, index, options.count))
  const child =
    options.spawnRun?.(args, workspace.dir) ??
    (() => {
      const command = self(args, workspace.dir)
      return spawn(command.file, command.args, {
        cwd: command.cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...options.env, [Brand.env.attempts]: "off", PWD: workspace.dir },
        windowsHide: true,
      })
    })()
  live.add(child)
  return new Promise((resolve) => {
    const lines: string[] = []
    let rest = ""
    let stderr = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = rest + chunk.toString("utf8")
      const parts = text.split("\n")
      rest = parts.pop() ?? ""
      lines.push(...parts)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000)
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (code: number | null) => {
      if (timer) clearTimeout(timer)
      live.delete(child)
      if (rest) lines.push(rest)
      // Whatever the run left behind in its process group goes too.
      stop(child, "SIGKILL")
      resolve({ lines, code, stderr })
    }
    child.on("error", (error) => {
      stderr += error.message
      done(null)
    })
    child.on("exit", (code, signal) => {
      // Give the pipes a moment to drain.
      timer = setTimeout(() => done(code ?? (signal ? 128 : null)), 200)
    })
  })
}

const lastLine = (text: string) =>
  text
    .split("\n")
    .map((item) => item.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .filter(Boolean)
    .pop()

export async function run(options: Options): Promise<Attempts.Summary> {
  const input = project(options.dir)
  const tiers = Attempts.tiers({ count: options.count, model: options.model, pro: options.pro })
  const tpm = options.tpm ?? (await Tpm.limit().catch(() => undefined))
  const parallel = Attempts.concurrency(options.count, tpm)
  const read = options.readSpend ?? keySpend
  const before = await read()
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `${Brand.name}-attempts-`))
  const outcomes: Attempts.Outcome[] = []
  const patches = new Map<number, string>()
  const onExit = () => cleanup()
  // A signal stops the children and removes the copies before the process ends.
  const onSignal = (signal: NodeJS.Signals) => {
    cleanup()
    fs.rmSync(scratch, { recursive: true, force: true })
    process.exit(signal === "SIGINT" ? 130 : 143)
  }
  process.once("exit", onExit)
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
  try {
    const queue = tiers.map((tier, index) => ({ tier, index }))
    const worker = async (slot: number) => {
      if (slot > 0) await new Promise((resolve) => setTimeout(resolve, (options.staggerMs ?? Attempts.STAGGER_MS) * slot))
      while (queue.length) {
        const { tier, index } = queue.shift()!
        const approach = Attempts.APPROACHES[index % Attempts.APPROACHES.length]!.name
        const started = Date.now()
        const base: Omit<Attempts.Outcome, "ended" | "checks" | "checksPassed" | "checksRun" | "diff" | "cost" | "costSource" | "seconds"> = {
          index,
          tier,
          approach,
        }
        let outcome: Attempts.Outcome
        try {
          const workspace = prepare(input, path.join(scratch, `attempt-${index + 1}`))
          workspaces.set(workspace.root, { input, workspace })
          options.onStart?.(index, tier, approach)
          const result = await runOne(options, workspace, index, tier)
          const events = Attempts.readEvents(result.lines)
          const { diff, patch } = change(workspace)
          if (patch) patches.set(index, patch)
          // 0 is done, 8 is done with checks failing; anything else stopped the attempt.
          const ended = result.code === 0 || result.code === 8 ? "ok" : "error"
          outcome = {
            ...base,
            ended,
            error: ended === "error" ? (events.error ?? lastLine(result.stderr) ?? `exit code ${result.code}`) : undefined,
            checks: events.checks,
            checksPassed: events.checksPassed,
            checksRun: events.checksRun,
            criteria: events.criteria,
            diff,
            cost: events.cost,
            costSource: events.unknownCost ? "partial" : "gateway",
            seconds: (Date.now() - started) / 1000,
          }
          remove(input, workspace)
          workspaces.delete(workspace.root)
        } catch (error) {
          outcome = {
            ...base,
            ended: "error",
            error: error instanceof Error ? error.message.split("\n")[0] : String(error),
            checks: "not_run",
            checksPassed: 0,
            checksRun: 0,
            diff: { files: 0, added: 0, removed: 0 },
            cost: 0,
            costSource: "gateway",
            seconds: (Date.now() - started) / 1000,
          }
        }
        outcomes.push(outcome)
        options.onEnd?.(outcome)
      }
    }
    await Promise.all(Array.from({ length: parallel }, (_, slot) => worker(slot)))
    outcomes.sort((a, b) => a.index - b.index)
    const picked = Attempts.pick(outcomes)
    const summed = outcomes.reduce((sum, item) => sum + item.cost, 0)
    let summary: Attempts.Summary = { outcomes, applied: false, total: summed, totalSource: "attempts" }
    if (picked) {
      const patch = patches.get(picked.winner.index)!
      const applied = apply(input, patch)
      summary = { ...summary, winner: picked.winner, reason: picked.reason, applied: applied.ok }
      if (!applied.ok) {
        const file = path.join(os.tmpdir(), `${Brand.name}-attempt-${picked.winner.index + 1}-${Date.now()}.patch`)
        fs.writeFileSync(file, patch)
        summary = { ...summary, applyError: applied.error, patchFile: file }
      }
    }
    // The key's spend over all the attempts, read again while the gateway catches up.
    if (before !== undefined) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const after = await read()
        if (after === undefined) break
        if (after > before || summed === 0 || attempt === 2) {
          summary = { ...summary, total: Math.max(0, after - before), totalSource: "key_spend" }
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    }
    return summary
  } finally {
    cleanup()
    process.removeListener("exit", onExit)
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

export * as AttemptsRun from "./attempts-run"
