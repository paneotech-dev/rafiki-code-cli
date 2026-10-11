// Auto mode and plan mode inside the permission service
// (src/permission/index.ts): what this machine looks like to the rule engine
// (core/brand/guarded.ts), which guarded actions a permission question
// carries, which of them a rule allows explicitly, and what plan mode refuses.
import os from "os"
import path from "path"
import fs from "fs"
import { spawnSync } from "child_process"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Credentials from "@opencode-ai/core/brand/credentials"
import * as Guarded from "@opencode-ai/core/brand/guarded"
import { Global } from "@opencode-ai/core/global"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import * as PublishGuard from "./publish-guard"

// ---------------------------------------------------------------------------
// Processes started by a session's shell commands. The shell tool starts each
// command in a process group of its own, so a process belongs to the session
// when its group is one the session started.

const started = new Map<string, Set<number>>()

export function recordProcess(sessionID: string, pid: number | undefined) {
  if (!pid) return
  const set = started.get(sessionID) ?? new Set<number>()
  set.add(pid)
  started.set(sessionID, set)
}

function group(pid: number): number | undefined {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
      // pid (comm) state ppid pgrp ...; comm may hold spaces and parentheses.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      return Number(fields[2])
    } catch {
      return undefined
    }
  }
  if (process.platform === "win32") return undefined
  const result = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 })
  const value = Number(result.stdout?.trim())
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export function owns(sessionID: string) {
  return (pid: number) => {
    const set = started.get(sessionID)
    if (!set) return false
    if (set.has(pid)) return true
    const pgid = group(pid)
    return pgid !== undefined && set.has(pgid)
  }
}

// ---------------------------------------------------------------------------
// The machine as the rule engine sees it.

const branches = new Map<string, string[]>()

function defaultBranches(cwd: string) {
  const cached = branches.get(cwd)
  if (cached) return cached
  const names = new Set(["main", "master"])
  const run = (args: string[]) => {
    try {
      const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] })
      return result.status === 0 ? result.stdout.trim() : ""
    } catch {
      return ""
    }
  }
  const remote = run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(/^origin\//, "")
  if (remote) names.add(remote)
  const configured = run(["config", "--get", "init.defaultBranch"])
  if (configured) names.add(configured)
  const list = Array.from(names)
  branches.set(cwd, list)
  return list
}

function temp() {
  const dirs = new Set([os.tmpdir(), Global.Path.tmp, "/tmp", "/var/tmp"])
  if (process.env["TMPDIR"]) dirs.add(process.env["TMPDIR"])
  for (const dir of Array.from(dirs)) {
    try {
      dirs.add(fs.realpathSync.native(dir))
    } catch {}
  }
  return Array.from(dirs).map((dir) => path.resolve(dir))
}

export function context(input: { cwd: string; directory: string; worktree: string; sessionID: string }): Guarded.Context {
  const home = process.env["OPENCODE_TEST_HOME"] ?? os.homedir()
  return {
    cwd: input.cwd,
    roots: Array.from(new Set([input.directory, input.worktree].filter((dir) => dir && dir !== "/"))),
    temp: temp(),
    home,
    authFiles: [Credentials.file(Brand.configDir()), path.join(Global.Path.data, "auth.json")],
    defaultBranches: defaultBranches(input.cwd),
    gitAlias: PublishGuard.gitAlias(input.cwd),
    owns: owns(input.sessionID),
    platform: process.platform,
  }
}

// ---------------------------------------------------------------------------
// Questions.

export interface Request {
  permission: string
  patterns: readonly string[]
  metadata: Record<string, unknown>
}

const EMAIL = new Set(["email", "email_send", "send_email", "mail", "send_mail"])
// Permissions that change nothing (plan mode lets them through).
const READS = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "lsp",
  "webfetch",
  "websearch",
  "codesearch",
  "skill",
  "todowrite",
  "todoread",
  "question",
  "task",
  "external_directory",
  "plan_enter",
  "plan_exit",
  "doom_loop",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
])

function shellText(request: Request) {
  const command = request.metadata["command"]
  return typeof command === "string" && command ? command : request.patterns.join("\n")
}

function files(request: Request, worktree: string) {
  const out = new Set<string>()
  const filepath = request.metadata["filepath"]
  if (typeof filepath === "string" && path.isAbsolute(filepath)) out.add(path.normalize(filepath))
  for (const pattern of request.patterns) {
    if (!pattern || pattern === "*") continue
    out.add(path.resolve(worktree, pattern))
  }
  return Array.from(out)
}

export interface Assessment {
  findings: Guarded.Finding[]
  // Shell commands the rules cannot classify.
  unknown: string[]
  // False when the action is known to change nothing.
  changes: boolean
}

// What a permission question is about, as far as the rules can tell.
export function assess(request: Request, ctx: Guarded.Context, worktree: string): Assessment {
  if (request.permission === "bash") {
    const result = Guarded.shell(shellText(request), ctx)
    return result
  }
  if (request.permission === "edit") {
    const findings = files(request, worktree).flatMap((file) => Guarded.fileWrite(file, ctx) ?? [])
    return { findings, unknown: [], changes: true }
  }
  if (request.permission === "read") {
    const findings = files(request, worktree).flatMap((file) => Guarded.fileRead(file, ctx) ?? [])
    return { findings, unknown: [], changes: false }
  }
  if (request.permission === "external_directory") {
    // Only the credential folders are guarded here; what is done in the
    // folder (a write, a delete) is guarded by its own question.
    const findings = request.patterns.flatMap((pattern) => {
      const dir = pattern.replace(/[\\/]\*$/, "")
      return Guarded.credentialPath(dir, ctx) || Guarded.credentialPath(path.join(dir, "x"), ctx)
        ? [{ kind: "credentials" as const, command: dir, key: dir, reason: `${Guarded.describe("credentials")}: ${dir}` }]
        : []
    })
    return { findings, unknown: [], changes: false }
  }
  if (EMAIL.has(request.permission)) {
    return {
      findings: [{ kind: "email", command: request.permission, key: request.permission, reason: Guarded.describe("email") }],
      unknown: [],
      changes: true,
    }
  }
  return { findings: [], unknown: [], changes: !READS.has(request.permission) }
}

// True when a rule written by the person allows this finding: an allow rule
// for this permission by name (not "*"), matching the command, whose fixed
// part covers the guarded words. A wildcard rule ("bash": "allow", "git *")
// is not an explicit allow of a guarded action.
export function explicitlyAllowed(finding: Guarded.Finding, request: Request, ruleset: PermissionV1.Ruleset) {
  const texts = [finding.command, ...request.patterns, shellText(request)]
  const rule = ruleset.findLast((item) => item.permission === request.permission && texts.some((text) => Wildcard.match(text, item.pattern)))
  if (!rule || rule.action !== "allow") return false
  if (request.permission !== "bash") return rule.pattern !== "*"
  return Guarded.covers(rule.pattern, finding)
}

// The note plan mode answers with, or undefined when the action may run.
export function planRefusal(request: Request, assessment: Assessment, worktree: string): string | undefined {
  if (request.permission === "edit") {
    // Plans may still be written.
    const plans = files(request, worktree).every((file) =>
      Brand.project.dirs.some((dir) => file.includes(`${path.sep}${dir}${path.sep}plans${path.sep}`) && file.endsWith(".md")),
    )
    if (plans) return undefined
    return Guarded.planNote(`the edit of ${request.patterns.join(", ")}`)
  }
  if (request.permission === "bash") {
    if (!assessment.changes) return undefined
    return Guarded.planNote(`the command \`${shellText(request)}\``)
  }
  if (request.permission === "publish") return Guarded.planNote(`the command \`${shellText(request)}\``)
  if (!assessment.changes) return undefined
  return Guarded.planNote(`the ${request.permission} tool call`)
}
