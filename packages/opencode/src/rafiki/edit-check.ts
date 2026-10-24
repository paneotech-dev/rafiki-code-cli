// The language checks after an edit: the errors an edit introduced go back to
// the model in the same tool result.
//
// 1. The language servers of the edited files (TypeScript and JavaScript,
//    Python, PHP: lsp/lsp.ts turns these on by default) are told about the
//    change and given WAIT_MS in all to report. A server that is still
//    starting, installing or slow is not waited for: it keeps going in the
//    background and the next edit gets its report.
// 2. Errors the file already had before the edit are left out when the server
//    knew the file before; the result says how many were left out.
// 3. A file no server reported on gets a syntax check instead, when the tool
//    is installed: python (compile), php -l, node --check, and JSON.parse for
//    package.json and composer.json. Each has SYNTAX_TIMEOUT_MS.
import fs from "fs"
import path from "path"
import { spawn } from "child_process"
import { Effect } from "effect"
import { Brand } from "@opencode-ai/core/brand/brand"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { which } from "@opencode-ai/core/util/which"
import type * as LSPClient from "@/lsp/client"
import { Diagnostic } from "@/lsp/diagnostic"

export const WAIT_MS = 6_000
export const SYNTAX_TIMEOUT_MS = 5_000

export function enabled(env: Record<string, string | undefined> = process.env) {
  const value = env[Brand.env.editChecks]?.trim().toLowerCase()
  return !(value && ["0", "off", "false", "no"].includes(value))
}

export interface Lsp {
  touchFile: (input: string, diagnostics?: "document" | "full") => Effect.Effect<void>
  diagnostics: () => Effect.Effect<Record<string, LSPClient.Diagnostic[]>>
}

export interface Report {
  file: string
  // new: only what the edit introduced; all: every error of the file (the
  // server did not know it before); syntax: from a syntax check.
  kind: "new" | "all" | "syntax"
  block: string
  // Errors that were there before the edit and are not shown.
  earlier: number
}

export interface Result {
  diagnostics: Record<string, LSPClient.Diagnostic[]>
  reports: Report[]
}

type Syntax = (file: string, ms: number) => Promise<LSPClient.Diagnostic[] | undefined>

const errorsOf = (items: LSPClient.Diagnostic[] | undefined) => (items ?? []).filter((item) => item.severity === 1)

const signature = (item: LSPClient.Diagnostic) => `${item.source ?? ""}|${item.code ?? ""}|${item.message}`

// The errors of after that before did not have, by message, as many times as
// they occur: a line moved by the edit is still the same error.
export function introduced(before: LSPClient.Diagnostic[], after: LSPClient.Diagnostic[]) {
  const left = new Map<string, number>()
  for (const item of errorsOf(before)) left.set(signature(item), (left.get(signature(item)) ?? 0) + 1)
  return errorsOf(after).filter((item) => {
    const count = left.get(signature(item)) ?? 0
    if (count === 0) return true
    left.set(signature(item), count - 1)
    return false
  })
}

// Runs after the files were written. `before` is what the servers reported
// before the edit (lsp.diagnostics(), read before writing).
export const afterEdit = Effect.fnUntraced(function* (input: {
  lsp: Lsp
  files: string[]
  before: Record<string, LSPClient.Diagnostic[]>
  wait?: number
  syntax?: Syntax
  env?: Record<string, string | undefined>
}) {
  if (!enabled(input.env)) return { diagnostics: {}, reports: [] } satisfies Result
  const files = [...new Set(input.files)]
  yield* Effect.forEach(files, (file) => input.lsp.touchFile(file, "document"), {
    concurrency: "unbounded",
    discard: true,
  }).pipe(Effect.timeoutOption(input.wait ?? WAIT_MS), Effect.ignoreCause)
  const diagnostics = yield* input.lsp.diagnostics()
  const check = input.syntax ?? syntax
  const reports: Report[] = []
  for (const file of files) {
    const key = FSUtil.normalizePath(file)
    const after = diagnostics[key]
    if (after === undefined) {
      const found = yield* Effect.promise(() => check(file, SYNTAX_TIMEOUT_MS).catch(() => undefined))
      const block = found?.length ? Diagnostic.report(file, found) : ""
      if (block) reports.push({ file, kind: "syntax", block, earlier: 0 })
      continue
    }
    const before = input.before[key]
    if (before === undefined) {
      const block = Diagnostic.report(file, after)
      if (block) reports.push({ file, kind: "all", block, earlier: 0 })
      continue
    }
    const fresh = introduced(before, after)
    const block = Diagnostic.report(file, fresh)
    if (block) reports.push({ file, kind: "new", block, earlier: errorsOf(after).length - fresh.length })
  }
  return { diagnostics, reports } satisfies Result
})

// The text added to the tool result for one file.
export function render(report: Report, name: string = report.file) {
  if (report.kind === "syntax") return `\n\nSyntax errors in ${name}, please fix:\n${report.block}`
  if (report.kind === "all") return `\n\nLSP errors detected in ${name}, please fix:\n${report.block}`
  const earlier =
    report.earlier > 0
      ? `\n(${report.earlier} error${report.earlier === 1 ? " that was" : "s that were"} already there before this edit ${report.earlier === 1 ? "is" : "are"} not shown.)`
      : ""
  return `\n\nNew errors after this edit in ${name}, please fix:\n${report.block}${earlier}`
}

// ---------------------------------------------------------------------------
// Syntax checks for files no language server reported on.

function diagnostic(line: number, column: number, message: string): LSPClient.Diagnostic {
  const position = { line: Math.max(line - 1, 0), character: Math.max(column - 1, 0) }
  return { range: { start: position, end: position }, severity: 1, message, source: "syntax" }
}

interface Exec {
  code: number | null
  output: string
  timedOut: boolean
}

function exec(command: string, args: string[], cwd: string, ms: number) {
  return new Promise<Exec>((resolve) => {
    let output = ""
    let timedOut = false
    const proc = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    const add = (chunk: Buffer) => {
      if (output.length < 64_000) output += chunk.toString("utf8")
    }
    proc.stdout.on("data", add)
    proc.stderr.on("data", add)
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGKILL")
    }, ms)
    proc.once("error", () => {
      clearTimeout(timer)
      resolve({ code: 127, output, timedOut })
    })
    proc.once("close", (code) => {
      clearTimeout(timer)
      resolve({ code, output, timedOut })
    })
  })
}

const PYTHON_CHECK = [
  "import sys",
  "path = sys.argv[1]",
  "try:",
  "    compile(open(path, 'rb').read(), path, 'exec', dont_inherit=True)",
  "except SyntaxError as e:",
  "    print('%s:%s:%s' % (e.lineno or 1, e.offset or 1, e.msg))",
  "    sys.exit(1)",
].join("\n")

// Parses the output of a syntax check; undefined when it could not run.
export function parse(kind: "python" | "php" | "node", done: Exec): LSPClient.Diagnostic[] | undefined {
  if (done.timedOut || done.code === 127 || done.code === null) return undefined
  if (done.code === 0) return []
  const text = done.output
  if (kind === "python") {
    const match = text.match(/^(\d+):(\d+):(.+)$/m)
    return match ? [diagnostic(Number(match[1]), Number(match[2]), `SyntaxError: ${match[3].trim()}`)] : undefined
  }
  if (kind === "php") {
    const match = text.match(/(?:PHP )?(Parse error|Fatal error):\s*(.+?) in .+? on line (\d+)/)
    return match ? [diagnostic(Number(match[3]), 1, `${match[1]}: ${match[2].trim()}`)] : undefined
  }
  const line = text.match(/^.+:(\d+)\r?$/m)
  const error = text.match(/^(SyntaxError: .+)$/m)
  if (!error) return undefined
  // Module syntax in a file an older node reads as a script is not an error of the edit.
  if (/Cannot use import statement|Unexpected token 'export'/.test(error[1])) return undefined
  return [diagnostic(line ? Number(line[1]) : 1, 1, error[1].trim())]
}

// JSX in a .js file is valid for the project's bundler but not for node --check.
const JSX = /<\/[A-Za-z]|\/>|return\s*\(?\s*<[A-Za-z]|=>\s*\(?\s*<[A-Za-z]/

let python: string | null | undefined

function pythonBinary() {
  if (python === undefined) python = which("python3") ?? which("python") ?? null
  return python ?? undefined
}

export const syntax: Syntax = async (file, ms) => {
  const ext = path.extname(file).toLowerCase()
  const cwd = path.dirname(file)
  const base = path.basename(file)
  if (base === "package.json" || base === "composer.json") {
    const text = await fs.promises.readFile(file, "utf8").catch(() => undefined)
    if (text === undefined || !text.trim()) return undefined
    try {
      JSON.parse(text)
      return []
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const line = message.match(/line (\d+)/)?.[1]
      return [diagnostic(line ? Number(line) : 1, 1, `Invalid JSON: ${message}`)]
    }
  }
  if (ext === ".py") {
    const bin = pythonBinary()
    if (!bin) return undefined
    return parse("python", await exec(bin, ["-I", "-c", PYTHON_CHECK, file], cwd, ms))
  }
  if (ext === ".php") {
    const bin = which("php")
    if (!bin) return undefined
    return parse("php", await exec(bin, ["-l", "-d", "display_errors=stderr", file], cwd, ms))
  }
  if (ext === ".mjs" || ext === ".cjs" || ext === ".js") {
    const bin = which("node")
    if (!bin) return undefined
    if (ext === ".js") {
      const text = await fs.promises.readFile(file, "utf8").catch(() => "")
      if (JSX.test(text)) return undefined
    }
    return parse("node", await exec(bin, ["--check", file], cwd, ms))
  }
  return undefined
}
