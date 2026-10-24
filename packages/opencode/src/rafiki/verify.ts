// The verify step: a turn that changed files is not reported as done until
// the project's own checks pass.
//
// 1. The checks are found from the project's files (package.json scripts,
//    pytest, a Makefile, go.mod, Cargo.toml, composer.json and phpunit) and
//    from the commands AGENTS.md names. A `verify` section in AGENTS.md, or
//    `verify.commands` in the config, replaces what is found. The result is
//    kept per project until one of the files it was read from changes.
// 2. After a turn that changed files, the narrowest checks run first (the
//    tests of the changed files or modules), then wider ones (type check,
//    lint, the whole test suite when no narrow test was found), all within one
//    time budget (120 s by default). A command that does not finish in time
//    is reported as not finished, never as a failure.
//    In a monorepo (npm, yarn or bun workspaces, pnpm-workspace.yaml, lerna,
//    nx or turbo, composer path repositories) the checks of each package the
//    turn touched run in that package, instead of the root's.
// 3. A step that fails is run once more with the turn's changes set aside
//    (the files as they were when the turn started, from the session
//    snapshot, put back right after). When it failed the same way before the
//    turn, it is reported as failing before the turn and does not count.
// 4. A failure goes back to the model for another fix round, up to
//    `verify.rounds` (2 by default). When the checks still fail, the answer
//    ends with "checks failing: ..." and `rafikicode run` exits with code 8.
//
// The commands run through the shell permission like any shell command, so a
// session where shell commands need approval asks for them first.
import fs from "fs"
import path from "path"
import { spawn, spawnSync } from "child_process"
import { Brand } from "@opencode-ai/core/brand/brand"
import { Shell } from "@opencode-ai/core/shell"
import { which } from "@opencode-ai/core/util/which"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { isNote } from "./stuck"

export interface Settings {
  enabled?: boolean
  commands?: string[]
  timeout?: number
  rounds?: number
}

export type Kind = "test" | "lint" | "typecheck" | "build" | "check"

// How a test command is pointed at a few files.
type Runner = "pytest" | "python-bin-test" | "unittest" | "js" | "go" | "phpunit"

export interface Check {
  kind: Kind
  command: string
  // Present when the command can run the tests of a few files only.
  narrow?: { runner: Runner; base: string }
}

export interface Plan {
  // config: verify.commands; agents: the verify section of AGENTS.md; detected: everything else.
  source: "config" | "agents" | "detected"
  checks: Check[]
}

export interface Step {
  kind: Kind
  scope: "narrow" | "wide"
  command: string
  // The package folder the command runs in, relative to the root (monorepos).
  cwd?: string
}

// preexisting: it failed, but the same way before the turn's changes.
export type StepStatus = "passed" | "failed" | "timeout" | "unavailable" | "skipped" | "preexisting"

export interface StepResult extends Step {
  status: StepStatus
  exit: number | null
  seconds: number
  output: string
}

// passed: every check that ran passed. failing: one failed. incomplete: none
// failed but one did not finish within the budget. unavailable: the tools the
// checks need are not installed here. refused: running them was not approved.
// none: the project has no check this step knows how to run.
export type Status = "passed" | "failing" | "incomplete" | "unavailable" | "refused" | "none"

export interface Result {
  status: Status
  steps: StepResult[]
  budget: number
}

// The key of the part metadata that carries a verify result.
export const METADATA = "verify"

export const DEFAULT_TIMEOUT = 120
export const MAX_TIMEOUT = 1800
export const DEFAULT_ROUNDS = 2
export const MAX_ROUNDS = 5
// Exit code of `rafikicode run` when the checks still fail at the end.
export const EXIT_CHECKS_FAILING = 8

const OUTPUT_TAIL = 6000
const NARROW_LIMIT = 6
const SCAN_LIMIT = 4000

// The env override: true, false, or undefined when unset or unreadable.
export function envSetting(env: Record<string, string | undefined> = process.env): boolean | undefined {
  const value = env[Brand.env.verify]?.trim().toLowerCase()
  if (!value) return undefined
  if (["1", "on", "true", "yes"].includes(value)) return true
  if (["0", "off", "false", "no"].includes(value)) return false
  return undefined
}

export function enabled(settings: Settings | undefined, env: Record<string, string | undefined> = process.env) {
  return envSetting(env) ?? settings?.enabled ?? true
}

export function timeout(settings: Settings | undefined) {
  const value = settings?.timeout ?? DEFAULT_TIMEOUT
  return Math.min(Math.max(value, 5), MAX_TIMEOUT)
}

export function rounds(settings: Settings | undefined) {
  const value = settings?.rounds ?? DEFAULT_ROUNDS
  return Math.min(Math.max(Math.floor(value), 0), MAX_ROUNDS)
}

// ---------------------------------------------------------------------------
// The working practice put in the stable system text while the step is on.

export const PRACTICE = [
  "# Working on a code change",
  "- When the task reports a bug, reproduce it first: write a test that fails because of the bug (a short script when the project has no test setup), run it and see it fail. Then fix the code, run it again until it passes, run the relevant existing tests, and keep the test.",
  "- Prefer reading the code that matters and editing it over long exploration of the repository. Once you understand the cause, make the change.",
  "- Network access may be restricted. Do not try to download packages, upstream releases or reference copies of the project to compare against; work from the code in front of you.",
  "- After a turn that changes files, the project's checks run automatically. If they fail, you get the failure and fix it; do not report success while a check fails.",
].join("\n")

// ---------------------------------------------------------------------------
// Finding the checks.

const MARKERS = [
  "package.json",
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
  "tox.ini",
  "pytest.ini",
  "Makefile",
  "makefile",
  "go.mod",
  "Cargo.toml",
  "composer.json",
  "phpunit.xml",
  "phpunit.xml.dist",
  "AGENTS.md",
  "bin/test",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
]

const cache = new Map<string, { signature: string; plan: Plan }>()

export function clearCache() {
  cache.clear()
}

function signature(root: string, settings: Settings | undefined) {
  const stamps = MARKERS.map((name) => {
    const stat = fs.statSync(path.join(root, name), { throwIfNoEntry: false })
    return stat ? `${name}:${stat.mtimeMs}:${stat.size}` : ""
  })
  return [...stamps, JSON.stringify(settings?.commands ?? null)].join("|")
}

// The checks of the project at root, kept until a file they were read from changes.
// `lockRoot` is where the lockfile is: the monorepo root for a package.
export function detect(
  root: string,
  settings?: Settings,
  probe: (python: string, root: string) => boolean = hasPytest,
  lockRoot: string = root,
): Plan {
  const sig = signature(root, settings) + "|" + (lockRoot === root ? "" : signature(lockRoot, undefined))
  const known = cache.get(root)
  if (known && known.signature === sig) return known.plan
  const plan = find(root, settings, probe, lockRoot)
  cache.set(root, { signature: sig, plan })
  return plan
}

function find(
  root: string,
  settings: Settings | undefined,
  probe: (python: string, root: string) => boolean,
  lockRoot: string = root,
): Plan {
  if (settings?.commands?.length) return { source: "config", checks: settings.commands.map(custom) }
  const agents = readText(path.join(root, "AGENTS.md"))
  const section = agents ? verifySection(agents) : undefined
  if (section?.length) return { source: "agents", checks: section.map(custom) }
  const found = [...node(root, lockRoot), ...python(root, probe), ...go(root), ...rust(root), ...php(root)]
  const named = agents ? agentsCommands(agents) : []
  const make = makefile(root)
  // AGENTS.md and the Makefile fill in the kinds the project files did not give.
  const extra = [...named, ...make].filter(
    (check, index, all) =>
      !found.some((item) => item.kind === check.kind) && all.findIndex((item) => item.kind === check.kind) === index,
  )
  return { source: "detected", checks: [...found, ...extra] }
}

function custom(command: string): Check {
  return { kind: "check", command }
}

function readText(file: string) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function exists(root: string, ...names: string[]) {
  return names.some((name) => fs.existsSync(path.join(root, name)))
}

// A `## Verify` section (any heading level) of AGENTS.md: the lines of its code
// blocks, or its list items written as code. A single `verify: <command>` line
// works too. Returns undefined when there is no such section.
export function verifySection(text: string): string[] | undefined {
  const lines = text.split(/\r?\n/)
  const inline = lines
    .map((line) => line.match(/^\s*verify:\s*`?([^`]+?)`?\s*$/i)?.[1])
    .filter((item): item is string => Boolean(item))
  const start = lines.findIndex((line) => /^#{1,6}\s+verify\b/i.test(line.trim()))
  if (start === -1) return inline.length ? inline : undefined
  const level = lines[start].trim().match(/^#+/)![0].length
  const commands: string[] = []
  let fenced = false
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    const trimmed = line.trim()
    // The section ends at the next heading of the same or a higher level.
    const heading = fenced ? null : trimmed.match(/^(#+)\s/)
    if (heading && heading[1].length <= level) break
    if (fenced) {
      if (trimmed && !trimmed.startsWith("#")) commands.push(trimmed.replace(/^\$\s+/, ""))
      continue
    }
    const item = trimmed.match(/^[-*]\s+`([^`]+)`/)?.[1]
    if (item) commands.push(item)
  }
  return [...commands, ...inline]
}

const KNOWN_TOOL =
  /^(npm|pnpm|yarn|bun|npx|bunx|deno|pytest|python3?|tox|nox|make|go|cargo|composer|phpunit|vendor\/bin\/\S+|\.\/vendor\/bin\/\S+|ruff|eslint|tsc|mypy|pyright|mvn|gradle|\.\/gradlew|dotnet|rake|bundle)\b/

// Commands AGENTS.md names for testing, linting, type checking or building:
// inline code on a line that says which it is.
export function agentsCommands(text: string): Check[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const kind = kindOf(line)
    if (!kind) return []
    return [...line.matchAll(/`([^`\n]+)`/g)]
      .map((match) => match[1].trim())
      .filter((command) => KNOWN_TOOL.test(command))
      .slice(0, 1)
      .map((command) => ({ kind, command }))
  })
}

function kindOf(line: string): Kind | undefined {
  const lower = line.toLowerCase()
  if (/\btype ?check|\btsc\b|\bmypy\b|\bpyright\b/.test(lower)) return "typecheck"
  if (/\blint/.test(lower)) return "lint"
  if (/\btests?\b|\btesting\b/.test(lower)) return "test"
  if (/\bbuild\b/.test(lower)) return "build"
  return undefined
}

const NPM_PLACEHOLDER = /no test specified/

function node(root: string, lockRoot: string = root): Check[] {
  const pkg = readJson(path.join(root, "package.json"))
  const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts ? (pkg.scripts as Record<string, unknown>) : {}
  const script = (name: string) => (typeof scripts[name] === "string" ? (scripts[name] as string) : undefined)
  const lock = (...names: string[]) => exists(root, ...names) || exists(lockRoot, ...names)
  const run = lock("bun.lock", "bun.lockb")
    ? "bun run"
    : lock("pnpm-lock.yaml")
      ? "pnpm run"
      : lock("yarn.lock")
        ? "yarn run"
        : "npm run"
  const checks: Check[] = []
  const typecheck = ["typecheck", "type-check", "check-types", "tsc"].find((name) => script(name))
  if (typecheck) checks.push({ kind: "typecheck", command: `${run} ${typecheck}` })
  if (script("lint")) checks.push({ kind: "lint", command: `${run} lint` })
  const test = script("test")
  if (test && !NPM_PLACEHOLDER.test(test)) {
    const base = `${run} test`
    const narrowable = /^\s*(vitest|jest|bun test)\b/.test(test)
    checks.push({
      kind: "test",
      command: base,
      ...(narrowable ? { narrow: { runner: "js" as const, base: run === "npm run" ? `${base} --` : base } } : {}),
    })
  }
  if (!typecheck && script("build")) checks.push({ kind: "build", command: `${run} build` })
  return checks
}

function readJson(file: string): Record<string, unknown> | undefined {
  const text = readText(file)
  if (!text) return undefined
  try {
    const value = JSON.parse(text)
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function usesPytest(root: string) {
  if (exists(root, "pytest.ini", "conftest.py")) return true
  if (/\[tool\.pytest|\bpytest\b/.test(readText(path.join(root, "pyproject.toml")) ?? "")) return true
  if (/\[tool:pytest\]|\bpytest\b/.test(readText(path.join(root, "setup.cfg")) ?? "")) return true
  if (/\[pytest\]|\bpytest\b/.test(readText(path.join(root, "tox.ini")) ?? "")) return true
  return ["tests", "test", "testing"].some((dir) => fs.existsSync(path.join(root, dir)))
}

function isPythonProject(root: string) {
  return exists(root, "pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "pytest.ini")
}

export function pythonCommand() {
  if (which("python")) return "python"
  if (which("python3")) return "python3"
  return undefined
}

// Isolated mode (-I): nothing is imported from the project before its checks are approved.
function hasPytest(python: string, root: string) {
  const result = spawnSync(python, ["-I", "-c", "import pytest"], { cwd: root, stdio: "ignore", timeout: 15_000 })
  return result.status === 0
}

function python(root: string, probe: (python: string, root: string) => boolean): Check[] {
  if (!isPythonProject(root)) return []
  const py = pythonCommand()
  if (!py) return []
  const checks: Check[] = []
  const pyproject = readText(path.join(root, "pyproject.toml")) ?? ""
  if (/\[tool\.ruff/.test(pyproject) || exists(root, "ruff.toml", ".ruff.toml"))
    if (which("ruff")) checks.push({ kind: "lint", command: "ruff check ." })
  if (/\[tool\.mypy/.test(pyproject) || exists(root, "mypy.ini"))
    if (which("mypy")) checks.push({ kind: "typecheck", command: "mypy ." })
  if (probe(py, root) && (usesPytest(root) || !exists(root, "bin/test"))) {
    const base = `${py} -m pytest -q -x -p no:cacheprovider`
    checks.push({ kind: "test", command: base, narrow: { runner: "pytest", base } })
    return checks
  }
  // Projects with a test runner of their own (sympy's bin/test).
  if (exists(root, "bin/test")) {
    const base = `${py} bin/test`
    checks.push({ kind: "test", command: base, narrow: { runner: "python-bin-test", base } })
    return checks
  }
  checks.push({
    kind: "test",
    command: `${py} -m unittest discover`,
    narrow: { runner: "unittest", base: `${py} -m unittest` },
  })
  return checks
}

function go(root: string): Check[] {
  if (!exists(root, "go.mod")) return []
  return [
    { kind: "build", command: "go vet ./..." },
    { kind: "test", command: "go test ./...", narrow: { runner: "go", base: "go test" } },
  ]
}

function rust(root: string): Check[] {
  if (!exists(root, "Cargo.toml")) return []
  return [
    { kind: "build", command: "cargo check --quiet" },
    { kind: "test", command: "cargo test --quiet" },
  ]
}

function php(root: string): Check[] {
  const composer = readJson(path.join(root, "composer.json"))
  const scripts =
    composer && typeof composer.scripts === "object" && composer.scripts ? (composer.scripts as Record<string, unknown>) : {}
  const phpunit = exists(root, "vendor/bin/phpunit") ? "vendor/bin/phpunit" : undefined
  const checks: Check[] = []
  if (scripts.lint) checks.push({ kind: "lint", command: "composer lint" })
  if (phpunit && exists(root, "phpunit.xml", "phpunit.xml.dist"))
    return [...checks, { kind: "test", command: phpunit, narrow: { runner: "phpunit", base: phpunit } }]
  if (scripts.test) return [...checks, { kind: "test", command: "composer test" }]
  if (phpunit) return [...checks, { kind: "test", command: phpunit, narrow: { runner: "phpunit", base: phpunit } }]
  return checks
}

function makefile(root: string): Check[] {
  const text = readText(path.join(root, "Makefile")) ?? readText(path.join(root, "makefile"))
  if (!text) return []
  const targets = new Set([...text.matchAll(/^([A-Za-z][\w-]*)\s*:(?!=)/gm)].map((match) => match[1]))
  const pick: [Kind, string[]][] = [
    ["typecheck", ["typecheck", "type-check"]],
    ["lint", ["lint"]],
    ["test", ["test", "check"]],
    ["build", ["build"]],
  ]
  return pick.flatMap(([kind, names]) => {
    const target = names.find((name) => targets.has(name))
    return target ? [{ kind, command: `make ${target}` }] : []
  })
}

// ---------------------------------------------------------------------------
// Choosing what to run for a set of changed files.

const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc|png|jpe?g|gif|svg|webp|ico|pdf)$/i
const DOC_NAME = /^(LICENSE|LICENCE|NOTICE|AUTHORS|CHANGELOG|CHANGES|\.gitignore|\.gitattributes)(\..*)?$/i

// True when a change set touches nothing but documentation and images.
export function onlyDocs(files: string[]) {
  return files.every((file) => DOC_FILE.test(file) || DOC_NAME.test(path.basename(file)))
}

// The commands to run, narrowest first. `files` are relative to root.
export function select(plan: Plan, root: string, files: string[], listing?: string[]): Step[] {
  if (plan.source !== "detected")
    return plan.checks.map((check) => ({
      kind: check.kind,
      scope: "wide" as const,
      command: check.command.includes("{files}") ? check.command.replaceAll("{files}", files.map(quote).join(" ")) : check.command,
    }))
  const all = listing ?? listFiles(root)
  const narrow = plan.checks.flatMap((check) => {
    if (check.kind !== "test" || !check.narrow) return []
    const command = narrowCommand(check.narrow, root, files, all)
    return command ? [{ kind: check.kind, scope: "narrow" as const, command }] : []
  })
  const order: Kind[] = ["build", "typecheck", "lint", "check", "test"]
  const wide = plan.checks
    .filter((check) => !(check.kind === "test" && narrow.length > 0))
    .toSorted((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
    .map((check) => ({ kind: check.kind, scope: "wide" as const, command: check.command }))
  return [...narrow, ...wide]
}

function quote(value: string) {
  if (/^[\w./@:+-]+$/.test(value)) return value
  if (process.platform === "win32") return `"${value.replaceAll('"', '""')}"`
  return `'${value.replaceAll("'", "'\\''")}'`
}

function narrowCommand(narrow: { runner: Runner; base: string }, root: string, files: string[], all: string[]) {
  if (narrow.runner === "go") {
    const dirs = [...new Set(files.filter((file) => file.endsWith(".go")).map((file) => path.posix.dirname(file)))]
    if (dirs.length === 0) return undefined
    return `${narrow.base} ${dirs.slice(0, NARROW_LIMIT).map((dir) => quote(dir === "." ? "." : `./${dir}`)).join(" ")}`
  }
  const targets =
    narrow.runner === "js"
      ? jsTests(files, all)
      : narrow.runner === "phpunit"
        ? phpTests(files, all).slice(0, 1)
        : pythonTests(root, files, all)
  // unittest takes test files, not folders.
  const usable = narrow.runner === "unittest" ? targets.filter((target) => target.endsWith(".py")) : targets
  if (usable.length === 0) return undefined
  return `${narrow.base} ${usable.map(quote).join(" ")}`
}

const PY_TEST = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/

// The test files of changed Python modules: changed tests themselves, then
// test_<name>.py anywhere (closest first), then test files that import the
// module, then the nearest tests folder of the package.
export function pythonTests(root: string, files: string[], all: string[]): string[] {
  const changed = files.filter((file) => file.endsWith(".py"))
  if (changed.length === 0) return []
  const tests = all.filter((file) => PY_TEST.test(file))
  const own = changed.filter((file) => PY_TEST.test(file) && tests.includes(file))
  const modules = changed.filter((file) => !PY_TEST.test(file) && path.posix.basename(file) !== "__init__.py")
  const byName = modules.flatMap((file) => {
    const stem = path.posix.basename(file, ".py")
    return closest(
      file,
      tests.filter((test) => [`test_${stem}.py`, `${stem}_test.py`].includes(path.posix.basename(test))),
    ).slice(0, 2)
  })
  const picked = unique([...own, ...byName])
  if (picked.length > 0) return picked.slice(0, NARROW_LIMIT)
  const importers = modules.flatMap((file) => importingTests(root, file, tests))
  if (importers.length > 0) return unique(importers).slice(0, NARROW_LIMIT)
  const dirs = modules.flatMap((file) => {
    const dir = path.posix.dirname(file)
    const candidates = [`${dir}/tests`, `${dir}/test`]
    return candidates.filter((candidate) => tests.some((test) => test.startsWith(candidate + "/"))).slice(0, 1)
  })
  return unique(dirs).slice(0, 2)
}

function importingTests(root: string, file: string, tests: string[]) {
  const dotted = file
    .replace(/^src\//, "")
    .replace(/\.py$/, "")
    .split("/")
    .join(".")
  if (!dotted.includes(".")) return []
  const pattern = new RegExp(`(from|import)\\s+${dotted.replaceAll(".", "\\.")}\\b`)
  return closest(file, tests)
    .slice(0, SCAN_LIMIT)
    .filter((test) => pattern.test(readText(path.join(root, test)) ?? ""))
    .slice(0, 3)
}

const JS_SOURCE = /\.(m|c)?(t|j)sx?$/
const JS_TEST = /\.(test|spec)\.(m|c)?(t|j)sx?$/

export function jsTests(files: string[], all: string[]): string[] {
  const changed = files.filter((file) => JS_SOURCE.test(file))
  const tests = all.filter((file) => JS_TEST.test(file))
  const own = changed.filter((file) => JS_TEST.test(file))
  const byName = changed
    .filter((file) => !JS_TEST.test(file))
    .flatMap((file) => {
      const stem = path.posix.basename(file).replace(JS_SOURCE, "")
      return closest(
        file,
        tests.filter((test) => path.posix.basename(test).replace(JS_TEST, "") === stem),
      ).slice(0, 2)
    })
  return unique([...own, ...byName]).slice(0, NARROW_LIMIT)
}

function phpTests(files: string[], all: string[]): string[] {
  const changed = files.filter((file) => file.endsWith(".php"))
  const tests = all.filter((file) => file.endsWith("Test.php"))
  const own = changed.filter((file) => file.endsWith("Test.php"))
  const byName = changed.flatMap((file) => {
    const name = path.posix.basename(file, ".php") + "Test.php"
    return closest(
      file,
      tests.filter((test) => path.posix.basename(test) === name),
    ).slice(0, 1)
  })
  return unique([...own, ...byName])
}

// Sorts candidates by how much of the path they share with file, most first.
function closest(file: string, candidates: string[]) {
  const parts = file.split("/")
  const shared = (other: string) => {
    const segments = other.split("/")
    const index = parts.findIndex((part, i) => segments[i] !== part)
    return index === -1 ? parts.length : index
  }
  return candidates.toSorted((a, b) => shared(b) - shared(a) || a.length - b.length)
}

function unique(items: string[]) {
  return [...new Set(items)]
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "dist", "build", "target", "vendor", "__pycache__", ".tox"])

// The project's files, relative and with forward slashes: tracked and new ones
// from git when it is a repository, else a bounded walk.
export function listFiles(root: string): string[] {
  const git = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15_000,
  })
  if (git.status === 0 && git.stdout) return git.stdout.split("\n").filter(Boolean)
  const out: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || out.length > 50_000) return
    const entries = (() => {
      try {
        return fs.readdirSync(path.join(root, dir), { withFileTypes: true })
      } catch {
        return []
      }
    })()
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(rel, depth + 1)
        continue
      }
      out.push(rel)
    }
  }
  walk("", 0)
  return out
}

// ---------------------------------------------------------------------------
// Which files a turn changed.

export interface FeedbackMeta {
  kind: "feedback"
  round: number
  rounds: number
  result: Result
}

export interface FinalMeta {
  kind: "final"
  rounds: number
  result: Result
}

export type Meta = FeedbackMeta | FinalMeta

export function metaOf(part: { type: string; metadata?: Record<string, unknown> }): Meta | undefined {
  if (part.type !== "text") return undefined
  const value = part.metadata?.[METADATA]
  if (!value || typeof value !== "object") return undefined
  const kind = (value as { kind?: unknown }).kind
  return kind === "feedback" || kind === "final" ? (value as Meta) : undefined
}

// A round of the review pass (rafiki/review.ts) continues the turn too.
function reviewRound(part: { type: string; metadata?: Record<string, unknown> }) {
  if (part.type !== "text") return false
  const value = part.metadata?.["review"] as { kind?: unknown } | undefined
  return value?.kind === "feedback"
}

// True for a message the session added to continue a turn: a verify fix
// round or a review round.
export function isRound(parts: readonly { type: string; metadata?: Record<string, unknown> }[]) {
  return parts.some((part) => metaOf(part)?.kind === "feedback" || reviewRound(part))
}

// The turn so far: from the last user message the user wrote (not a verify
// or review round) to the end. Returns the files it changed, absolute, and
// how many verify rounds it has had.
export function turn(messages: SessionV1.WithParts[], directory: string) {
  // A stuck note (rafiki/stuck.ts) is not a new turn either.
  const start = messages.findLastIndex((msg) => msg.info.role === "user" && !isRound(msg.parts) && !isNote(msg))
  const since = start === -1 ? [] : messages.slice(start)
  const used = since.filter(
    (msg) => msg.info.role === "user" && msg.parts.some((part) => metaOf(part)?.kind === "feedback"),
  ).length
  const files = new Set<string>()
  // Files the turn created: they did not exist before it.
  const created = new Set<string>()
  for (const msg of since) {
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type === "patch") part.files.forEach((file) => files.add(path.resolve(directory, file)))
      if (part.type !== "tool" || part.state.status !== "completed") continue
      const input = part.state.input as { filePath?: unknown }
      if ((part.tool === "edit" || part.tool === "write") && typeof input.filePath === "string") {
        const file = path.resolve(directory, input.filePath)
        const existed = (part.state.metadata as { exists?: unknown } | undefined)?.exists
        if (part.tool === "write" && existed === false && !files.has(file)) created.add(file)
        files.add(file)
      }
      const changed = (part.state.metadata as { files?: unknown } | undefined)?.files
      if (part.tool === "apply_patch" && Array.isArray(changed))
        for (const item of changed) {
          const entry = item as { filePath?: unknown; movePath?: unknown; type?: unknown }
          const target = typeof entry.movePath === "string" ? entry.movePath : entry.filePath
          if (typeof target !== "string") continue
          const file = path.resolve(directory, target)
          if ((entry.type === "add" || typeof entry.movePath === "string") && !files.has(file)) created.add(file)
          files.add(file)
        }
    }
  }
  const last = since
    .flatMap((msg) => (msg.info.role === "user" ? msg.parts.map(metaOf) : []))
    .filter((meta): meta is FeedbackMeta => meta?.kind === "feedback")
    .at(-1)
  return { files: [...files], created: [...created], rounds: used, last: last?.result }
}

// The snapshot taken when the turn started: the first step of its first answer.
export function turnSnapshot(messages: SessionV1.WithParts[]) {
  const start = messages.findLastIndex((msg) => msg.info.role === "user" && !isNote(msg))
  if (start === -1) return undefined
  for (const msg of messages.slice(start)) {
    if (msg.info.role !== "assistant") continue
    const part = msg.parts.find((item) => item.type === "step-start" && item.snapshot)
    if (part && part.type === "step-start") return part.snapshot
  }
  return undefined
}

// Changed files relative to root, without the tool's own folders and files outside root.
export function relevant(root: string, files: string[]) {
  return files
    .map((file) => path.relative(root, file).replaceAll("\\", "/"))
    .filter((file) => file && !file.startsWith("..") && !path.isAbsolute(file))
    .filter((file) => !file.startsWith(".rafiki/") && !file.startsWith(".rafikicode/") && !file.startsWith(".opencode/"))
}

// ---------------------------------------------------------------------------
// Monorepos: the checks of each package the turn touched.

const MANIFESTS = ["package.json", "composer.json", "pyproject.toml"]
export const PACKAGE_LIMIT = 4

// True when root is a monorepo whose packages have checks of their own.
export function monorepo(root: string) {
  const pkg = readJson(path.join(root, "package.json"))
  if (pkg && pkg.workspaces) return true
  if (exists(root, "pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json")) return true
  const composer = readJson(path.join(root, "composer.json"))
  const repositories = composer?.repositories
  const list = Array.isArray(repositories)
    ? repositories
    : repositories && typeof repositories === "object"
      ? Object.values(repositories)
      : []
  return list.some((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "path")
}

// The package folder of a file (relative to root, with forward slashes): the
// nearest folder below root with a manifest, or undefined for the root's own files.
export function packageOf(root: string, file: string) {
  const parts = file.split("/").slice(0, -1)
  for (let end = parts.length; end > 0; end--) {
    const dir = parts.slice(0, end)
    if (dir.some((part) => SKIP_DIRS.has(part))) continue
    const rel = dir.join("/")
    if (MANIFESTS.some((name) => fs.existsSync(path.join(root, rel, name)))) return rel
  }
  return undefined
}

// The steps for a set of changed files: per package in a monorepo, else the root's.
export function plan(
  root: string,
  files: string[],
  settings?: Settings,
  probe: (python: string, root: string) => boolean = hasPytest,
): Step[] {
  const top = detect(root, settings, probe)
  if (top.source !== "detected" || !monorepo(root)) return select(top, root, files)
  const groups = new Map<string, string[]>()
  const rest: string[] = []
  for (const file of files) {
    const pkg = packageOf(root, file)
    if (!pkg) {
      rest.push(file)
      continue
    }
    groups.set(pkg, [...(groups.get(pkg) ?? []), file.slice(pkg.length + 1)])
  }
  const steps: Step[] = []
  for (const [pkg, own] of [...groups].slice(0, PACKAGE_LIMIT)) {
    if (onlyDocs(own)) continue
    const dir = path.join(root, pkg)
    const checks = detect(dir, undefined, probe, root)
    if (checks.checks.length === 0) {
      rest.push(...own.map((file) => `${pkg}/${file}`))
      continue
    }
    steps.push(...select(checks, dir, own).map((step) => ({ ...step, cwd: pkg })))
  }
  // Packages past the limit, and files outside any package, get the root's checks.
  for (const [pkg, own] of [...groups].slice(PACKAGE_LIMIT)) rest.push(...own.map((file) => `${pkg}/${file}`))
  if (rest.length > 0 && !onlyDocs(rest)) steps.push(...select(top, root, rest))
  return steps
}

// How a step is shown: the package folder first when it runs in one.
export function label(step: Step) {
  return step.cwd ? `${step.cwd}: ${step.command}` : step.command
}

// ---------------------------------------------------------------------------
// Failures that were there before the turn.

// The files of the turn as they were when it started: absolute path to
// content, undefined for a file that did not exist.
export type Before = Map<string, string | undefined>

const BASELINE_FILE_LIMIT = 200
const BASELINE_SIZE_LIMIT = 4 * 1024 * 1024

// Lines that name one failure, in the formats of the common runners, with
// what changes between runs (positions, timings) left out.
export function failureLines(output: string): string[] {
  const lines = new Set<string>()
  for (const raw of output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/)) {
    const line = raw.trim()
    let match: RegExpMatchArray | null
    if ((match = line.match(/^(FAILED|ERROR)\s+(\S+)/))) lines.add(`${match[1]} ${match[2]}`)
    else if ((match = line.match(/^FAIL\s+(\S+)/))) lines.add(`FAIL ${match[1]}`)
    else if ((match = line.match(/^(?:✕|×|✗)\s+(.+?)(?:\s+\(?\d+(?:\.\d+)?\s?m?s\)?)?$/))) lines.add(`x ${match[1]}`)
    else if ((match = line.match(/^--- FAIL: (\S+)/))) lines.add(`FAIL ${match[1]}`)
    else if ((match = line.match(/^\d+\) ([\w\\]+::\w+)/))) lines.add(`phpunit ${match[1]}`)
    else if ((match = line.match(/^(.+?)[(:]\d+[,:]\d+\)?:?\s*-?\s*error\s+(TS\d+):\s*(.*)$/))) lines.add(`${match[1]} ${match[2]} ${match[3]}`)
    else if ((match = line.match(/^\d+:\d+\s+error\s+(.+)$/))) lines.add(`eslint ${match[1].replace(/\s+/g, " ")}`)
    else if ((match = line.match(/^(.+?):\d+:(?:\d+:)? error: (.+)$/))) lines.add(`${match[1]} ${match[2]}`)
  }
  return [...lines]
}

// Whether the failure of a step is the one it had before the turn: the
// baseline run failed too, with no failure the current run names that the
// baseline run does not (or, when neither names any, with the same exit code).
export function compare(current: Exec, baseline: Exec): "preexisting" | "new" | undefined {
  if (baseline.timedOut || baseline.exit === 127) return undefined
  if (baseline.exit === 0) return "new"
  const now = failureLines(current.output)
  const then = new Set(failureLines(baseline.output))
  if (now.length === 0 && then.size === 0) return current.exit === baseline.exit ? "preexisting" : "new"
  if (now.length === 0) return "new"
  return now.every((line) => then.has(line)) ? "preexisting" : "new"
}

const baselines = new Map<string, Exec>()

// Runs a command with the turn's files as they were before it, and puts the
// current files back whatever happens. Returns undefined when it could not.
export async function baselineExec(input: {
  command: string
  cwd: string
  ms: number
  shell?: string
  signal?: AbortSignal
  before: Before
  // Identifies the state before the turn (the snapshot), for the cache.
  key?: string
  exec?: (command: string, cwd: string, ms: number, shell: string | undefined, signal?: AbortSignal) => Promise<Exec>
}): Promise<Exec | undefined> {
  const id = input.key ? `${input.key}|${input.cwd}|${input.command}` : undefined
  const cached = id ? baselines.get(id) : undefined
  if (cached) return cached
  if (input.before.size === 0 || input.before.size > BASELINE_FILE_LIMIT) return undefined
  const current = new Map<string, Buffer | undefined>()
  for (const file of input.before.keys()) {
    const stat = fs.statSync(file, { throwIfNoEntry: false })
    if (stat && (!stat.isFile() || stat.size > BASELINE_SIZE_LIMIT)) return undefined
    current.set(file, stat ? fs.readFileSync(file) : undefined)
  }
  const put = (file: string, content: string | Buffer | undefined) => {
    if (content === undefined) fs.rmSync(file, { force: true })
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
    }
  }
  // Put back on an interrupt too: the files must never stay as they were before the turn.
  const restore = () => {
    for (const [file, content] of current) {
      try {
        put(file, content)
      } catch {}
    }
  }
  process.once("exit", restore)
  try {
    for (const [file, content] of input.before) put(file, content)
    const done = await (input.exec ?? execute)(input.command, input.cwd, input.ms, input.shell, input.signal)
    if (id && !done.timedOut) baselines.set(id, done)
    return done
  } catch {
    return undefined
  } finally {
    restore()
    process.removeListener("exit", restore)
  }
}

export function clearBaselines() {
  baselines.clear()
}

// ---------------------------------------------------------------------------
// Running the steps.

const UNAVAILABLE = [
  /command not found/i,
  /No module named (pytest|unittest)/,
  /is not recognized as an internal or external command/i,
  /: not found\s*$/m,
  /ERR_PNPM_NO_SCRIPT|Missing script:/,
]

export function classify(step: Step, exit: number | null, output: string, timedOut: boolean): StepStatus {
  if (timedOut) return "timeout"
  if (exit === 0) return "passed"
  // pytest: no tests were collected for these files.
  if (exit === 5 && /pytest/.test(step.command)) return "passed"
  if (exit === 127 || UNAVAILABLE.some((pattern) => pattern.test(output))) return "unavailable"
  return "failed"
}

export async function run(input: {
  steps: Step[]
  cwd: string
  budget: number
  shell?: string
  signal?: AbortSignal
  exec?: (command: string, cwd: string, ms: number, shell: string | undefined, signal?: AbortSignal) => Promise<Exec>
  // The turn's files before it, to tell a failure that was there already.
  before?: Before
  beforeKey?: string
}): Promise<Result> {
  const exec = input.exec ?? execute
  const deadline = Date.now() + input.budget * 1000
  const steps: StepResult[] = []
  for (const step of input.steps) {
    const left = deadline - Date.now()
    if (input.signal?.aborted) break
    if (left < 1000) {
      steps.push({ ...step, status: "skipped", exit: null, seconds: 0, output: "" })
      continue
    }
    const started = Date.now()
    const cwd = step.cwd ? path.join(input.cwd, step.cwd) : input.cwd
    const done = await exec(step.command, cwd, left, input.shell, input.signal)
    let status = classify(step, done.exit, done.output, done.timedOut)
    if (status === "failed" && input.before && !input.signal?.aborted) {
      const ms = deadline - Date.now()
      const then =
        ms >= 1000
          ? await baselineExec({
              command: step.command,
              cwd,
              ms,
              shell: input.shell,
              signal: input.signal,
              before: input.before,
              key: input.beforeKey,
              exec,
            })
          : undefined
      if (then && compare(done, then) === "preexisting") status = "preexisting"
    }
    steps.push({ ...step, status, exit: done.exit, seconds: (Date.now() - started) / 1000, output: tail(done.output) })
    // Stop at the first failure: the model fixes it and the next round runs again.
    if (status === "failed") break
  }
  return { status: summarize(steps), steps, budget: input.budget }
}

export function summarize(steps: StepResult[]): Status {
  if (steps.length === 0) return "none"
  if (steps.some((step) => step.status === "failed")) return "failing"
  if (steps.some((step) => step.status === "timeout")) return "incomplete"
  if (steps.some((step) => step.status === "skipped") && steps.some((step) => step.status === "passed")) return "incomplete"
  if (!steps.some((step) => step.status === "passed" || step.status === "preexisting")) return "unavailable"
  return "passed"
}

export interface Exec {
  exit: number | null
  output: string
  timedOut: boolean
}

function execute(command: string, cwd: string, ms: number, shell: string | undefined, signal?: AbortSignal) {
  const file = Shell.acceptable(shell)
  return new Promise<Exec>((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let timedOut = false
    let exited = false
    const proc = spawn(file, Shell.args(file, command, cwd), {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, CI: process.env.CI ?? "1", FORCE_COLOR: "0", NO_COLOR: "1" },
    })
    const keep = (chunk: Buffer) => {
      chunks.push(chunk)
      size += chunk.length
      // Only the end is kept: that is where test runners print their summary.
      while (size > OUTPUT_TAIL * 8 && chunks.length > 1) size -= chunks.shift()!.length
    }
    proc.stdout?.on("data", keep)
    proc.stderr?.on("data", keep)
    const stop = () => {
      void Shell.killTree(proc, { exited: () => exited })
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, ms)
    signal?.addEventListener("abort", stop, { once: true })
    const finish = (exit: number | null, extra = "") => {
      if (exited) return
      exited = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", stop)
      resolve({ exit, output: Buffer.concat(chunks).toString("utf8") + extra, timedOut })
    }
    proc.once("error", (error) => finish(127, `\n${error.message}`))
    proc.once("close", (code) => finish(code))
  })
}

function tail(text: string) {
  const clean = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
  if (clean.length <= OUTPUT_TAIL) return clean
  return "...\n" + clean.slice(clean.length - OUTPUT_TAIL)
}

// ---------------------------------------------------------------------------
// What the model and the user read.

function seconds(value: number) {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} s`
}

// True when a round failed exactly like the round before it: the same
// commands with the same output. Another round would most likely be spent
// the same way (a failure that was there before the change, for example).
export function sameFailure(previous: Result | undefined, current: Result) {
  if (!previous) return false
  const key = (result: Result) =>
    JSON.stringify(
      result.steps.filter((step) => step.status === "failed").map((step) => [step.cwd, step.command, step.exit, step.output]),
    )
  return key(previous) === key(current)
}

// The message that sends a failure back to the model.
export function feedback(result: Result, round: number, total: number) {
  const failed = result.steps.filter((step) => step.status === "failed")
  const passed = result.steps.filter((step) => step.status === "passed")
  const earlier = result.steps.filter((step) => step.status === "preexisting")
  return [
    `The project's checks failed after your changes (verify round ${round} of ${total}).`,
    "",
    ...failed.flatMap((step) => [
      `$ ${step.cwd ? `(in ${step.cwd}) ` : ""}${step.command}`,
      `exit code ${step.exit} after ${seconds(step.seconds)}`,
      step.output.trim() || "(no output)",
      "",
    ]),
    ...(passed.length ? [`Passed: ${passed.map(label).join(", ")}`, ""] : []),
    ...(earlier.length
      ? [`Failing before your changes too, so not caused by them (leave these alone): ${earlier.map(label).join(", ")}`, ""]
      : []),
    "Find the cause and fix it, then run the failing check again yourself. Do not weaken or delete tests to make them pass. If the failure is not caused by your change (it also fails without it), say so in your answer and stop.",
  ].join("\n")
}

// The line added to the answer once the step is over.
export function finalLine(result: Result, rounds: number): string {
  const list = (status: StepStatus) =>
    result.steps
      .filter((step) => step.status === status)
      .map(label)
      .join(", ")
  const passed = list("passed")
  const earlier = list("preexisting")
  const before = earlier ? `; failing before this turn too, not caused by it: ${earlier}` : ""
  if (result.status === "passed") return passed ? `checks passed: ${passed}${before}` : `checks: ${earlier} failing before this turn too, not caused by it`
  if (result.status === "failing") {
    const failed = result.steps
      .filter((step) => step.status === "failed")
      .map((step) => `${label(step)} (exit code ${step.exit})`)
      .join(", ")
    const tried = rounds > 0 ? ` after ${rounds} fix round${rounds === 1 ? "" : "s"}` : ""
    return `checks failing: ${failed}${tried}. The changes are not verified${before}.`
  }
  if (result.status === "incomplete") {
    const late = [list("timeout"), list("skipped")].filter(Boolean).join(", ")
    return `checks not finished within ${result.budget} s: ${late}${passed ? `; passed: ${passed}` : ""}${before}`
  }
  if (result.status === "unavailable")
    return `checks not run: ${list("unavailable") || list("skipped")} cannot run here (the tool it needs is missing)`
  if (result.status === "refused") return `checks not run: running ${result.steps.map((step) => step.command).join(", ")} was not approved`
  return `no checks found for this project, so the changes were not verified (add a verify section to AGENTS.md or verify.commands to the config)`
}

// A short status word for the Task: line and the JSON output.
export function statusLine(status: Status | "off" | "not_run") {
  if (status === "passed") return "checks passed"
  if (status === "failing") return "checks failing"
  if (status === "incomplete") return "checks not finished"
  if (status === "unavailable") return "checks could not run"
  if (status === "refused") return "checks not approved"
  if (status === "none") return "no checks found"
  return "checks not run"
}

// The verify status of a run for the JSON output, sent only when the step ran.
export function summary(meta: FinalMeta | undefined) {
  if (!meta) return { status: "not_run" }
  return {
    status: meta.result.status,
    rounds: meta.rounds,
    budget: meta.result.budget,
    checks: meta.result.steps.map((step) => ({
      command: step.command,
      ...(step.cwd ? { cwd: step.cwd } : {}),
      kind: step.kind,
      scope: step.scope,
      status: step.status,
      exit: step.exit,
      seconds: Math.round(step.seconds * 10) / 10,
    })),
  }
}
