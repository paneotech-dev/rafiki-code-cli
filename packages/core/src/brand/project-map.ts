// Project map (opt-in): a code graph of the project built by graphify
// (https://github.com/Graphify-Labs/graphify, PyPI package graphifyy), served
// to the agent as MCP tools it calls when it needs them ("what calls X",
// "how does A reach B"). Nothing is added to the system prompt: the map costs
// tokens only when a tool is called.
//
// Off by default. "map": { "graphify": true } in rafikicode.json or
// RAFIKICODE_MAP=1 turns it on; RAFIKICODE_MAP=0 turns it off.
//
// Privacy: graphify runs in code-only mode (tree-sitter on this machine) with
// every LLM backend disabled (GRAPHIFY_BACKEND=none) and the provider keys
// blanked in its environment, so no file content leaves the machine. The
// graph is written to the cache folder of this app, keyed by project, never
// into the project. graphify is never installed for the person: when it is
// missing, the one-line install command for their system is shown instead.
import { spawn, spawnSync } from "child_process"
import { createHash } from "crypto"
import fs from "fs"
import path from "path"

export const NAME = "graphify"
export const PACKAGE = "graphifyy[mcp]"
export const ENV = "RAFIKICODE_MAP"
// The graphify tools the agent sees. The pull request tools (list_prs,
// get_pr_impact, triage_prs) call GitHub and, for triage, a model: left out.
export const TOOLS = ["query_graph", "get_neighbors", "get_node", "shortest_path"] as const
// Set in the environment of the MCP server this module registers, so the
// tool filter applies to it and never to a "graphify" server someone
// configured by hand.
export const MARKER = "RAFIKICODE_PROJECT_MAP"
// Longest first build at the start of a session; /map has no limit.
export const START_BUILD_MS = 90_000

export interface Settings {
  graphify?: boolean
}

// The value of RAFIKICODE_MAP: true, false, or undefined when unset or unreadable.
export function envSetting(raw: string | undefined): boolean | undefined {
  const value = raw?.trim().toLowerCase()
  if (!value) return undefined
  if (["1", "on", "true", "yes"].includes(value)) return true
  if (["0", "off", "false", "no"].includes(value)) return false
  return undefined
}

export function enabled(settings: Settings | undefined, raw: string | undefined = process.env[ENV]) {
  return envSetting(raw) ?? settings?.graphify === true
}

// How graphify is started: its own commands when they are on PATH (uv tool,
// pipx), else through Python (pip install --user leaves the scripts off PATH
// on many systems; Windows has the py launcher).
export interface Launcher {
  via: "path" | "python"
  cli: string[]
  mcp: string[]
}

export interface DetectIo {
  platform: NodeJS.Platform
  which(cmd: string): string | null
  // Runs a short command, true when it exits 0.
  probe(cmd: string[]): boolean
}

export function pythonCandidates(platform: NodeJS.Platform, which: (cmd: string) => string | null) {
  const list: string[][] = []
  if (platform === "win32") {
    const py = which("py")
    if (py) list.push([py, "-3"])
    const python = which("python")
    if (python) list.push([python])
    return list
  }
  for (const name of ["python3", "python"]) {
    const found = which(name)
    if (found) list.push([found])
  }
  return list
}

export function detect(io: DetectIo): Launcher | undefined {
  const cli = io.which("graphify")
  const mcp = io.which("graphify-mcp")
  if (cli && mcp) return { via: "path", cli: [cli], mcp: [mcp] }
  for (const python of pythonCandidates(io.platform, io.which)) {
    // The MCP server needs the mcp extra: import both.
    if (io.probe([...python, "-c", "import graphify.serve, mcp"]))
      return { via: "python", cli: [...python, "-m", "graphify"], mcp: [...python, "-m", "graphify.serve"] }
  }
  return undefined
}

export function defaultProbe(cmd: string[]) {
  const [bin, ...args] = cmd
  try {
    const result = spawnSync(bin, args, { stdio: "ignore", timeout: 15_000, windowsHide: true })
    return result.status === 0
  } catch {
    return false
  }
}

// One line the person can paste, for their system and the installers they have.
export function installCommand(platform: NodeJS.Platform, which: (cmd: string) => string | null) {
  const quoted = `"${PACKAGE}"`
  if (which("uv")) return `uv tool install ${quoted}`
  if (which("pipx")) return `pipx install ${quoted}`
  if (platform === "win32") return `py -m pip install --user ${quoted}`
  return `python3 -m pip install --user ${quoted}`
}

export function missingMessage(platform: NodeJS.Platform, which: (cmd: string) => string | null) {
  return `The project map needs graphify, which is not installed. Install it with: ${installCommand(platform, which)}`
}

// Where the graph of a project is kept: <cache>/project-map/<hash of the folder>.
export function outDir(root: string, cache: string) {
  const key = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16)
  return path.join(cache, "project-map", key)
}

export function graphFile(root: string, cache: string) {
  return path.join(outDir(root, cache), "graphify-out", "graph.json")
}

// Variables that could let graphify reach a model: blanked for its processes.
const PROVIDER_VARS = [
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "OLLAMA_BASE_URL",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_OPENAI_ENDPOINT",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
]

export function isProviderVar(name: string) {
  const upper = name.toUpperCase()
  return PROVIDER_VARS.includes(upper) || /(_API_KEY|_TOKEN|_SECRET)$/.test(upper)
}

// The environment graphify gets on top of the inherited one: no backend, no
// query log in the home folder, output in the cache folder, provider
// variables present in `base` set to empty.
export function graphifyEnv(root: string, cache: string, base: Record<string, string | undefined> = process.env) {
  const env: Record<string, string> = {}
  for (const name of Object.keys(base)) if (isProviderVar(name)) env[name] = ""
  env.GRAPHIFY_BACKEND = "none"
  env.GRAPHIFY_QUERY_LOG_DISABLE = "1"
  env.GRAPHIFY_OUT = path.join(outDir(root, cache), "graphify-out")
  env.PYTHONIOENCODING = "utf-8"
  env[MARKER] = "1"
  return env
}

// The MCP server entry for the session (the shape of a "local" entry in the "mcp" config).
export function mcpEntry(launcher: Launcher, root: string, cache: string, base?: Record<string, string | undefined>) {
  return {
    type: "local" as const,
    command: [...launcher.mcp, graphFile(root, cache)],
    environment: graphifyEnv(root, cache, base),
    cwd: outDir(root, cache),
    timeout: 30_000,
  }
}

export function isOurs(entry: { environment?: Record<string, string> } | undefined) {
  return entry?.environment?.[MARKER] === "1"
}

// Short descriptions that say what the graph is (this project's code), in place of graphify's own.
const DESCRIPTIONS: Record<(typeof TOOLS)[number], string> = {
  query_graph:
    "Project map (code graph of this project, built locally): find the functions, classes and files related to a question or name, with their calls, imports and file:line. Use it before wide searches when asking where something lives or what calls it.",
  get_neighbors:
    "Project map: every direct link of one function, class or file (who calls it, what it calls, imports, where it is defined), with file:line.",
  get_node: "Project map: details of one function, class or file by name (file, line, links).",
  shortest_path: "Project map: how one name reaches another through calls and imports, hop by hop with file:line.",
}
// query_graph options kept; the rest stay at graphify's defaults.
const QUERY_OPTIONS = ["question", "mode", "depth", "token_budget"]

export function filterTools<T extends { name: string; description?: string; inputSchema?: unknown }>(defs: T[]): T[] {
  return defs
    .filter((def) => (TOOLS as readonly string[]).includes(def.name))
    .map((def) => {
      const description = DESCRIPTIONS[def.name as (typeof TOOLS)[number]]
      const schema = def.inputSchema as { properties?: Record<string, unknown> } | undefined
      if (def.name !== "query_graph" || !schema?.properties) return { ...def, description }
      const properties = Object.fromEntries(
        Object.entries(schema.properties).filter(([key]) => QUERY_OPTIONS.includes(key)),
      )
      return { ...def, description, inputSchema: { ...schema, properties } }
    })
}

export interface BuildResult {
  ok: boolean
  files: number
  nodes: number
  edges: number
  ms: number
  graph: string
  error?: string
}

// Reads graphify extract's progress lines: "found 12 code, ..." and
// "wrote .../graph.json: 40 nodes, 52 edges, 3 communities".
export function parseOutput(text: string) {
  const files = Number(/found (\d+) code/.exec(text)?.[1] ?? 0)
  const wrote = /graph\.json: (\d+) nodes, (\d+) edges/.exec(text)
  return { files, nodes: Number(wrote?.[1] ?? 0), edges: Number(wrote?.[2] ?? 0) }
}

export interface BuildOptions {
  timeoutMs?: number
  onLine?: (line: string) => void
  env?: Record<string, string | undefined>
}

// Builds or refreshes the graph (graphify extract --code-only, incremental
// after the first run). Never writes into the project; if graphify ever
// leaves a graphify-out folder there, it is listed in .git/info/exclude.
export function build(launcher: Launcher, root: string, cache: string, options: BuildOptions = {}): Promise<BuildResult> {
  const out = outDir(root, cache)
  const graph = graphFile(root, cache)
  fs.mkdirSync(out, { recursive: true })
  const hadOutput = fs.existsSync(path.join(root, "graphify-out"))
  const base = options.env ?? process.env
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined && !isProviderVar(key)) env[key] = value
  Object.assign(env, graphifyEnv(root, cache, {}))
  const [bin, ...prefix] = launcher.cli
  const args = [...prefix, "extract", path.resolve(root), "--code-only", "--out", out]
  const started = Date.now()
  return new Promise((resolve) => {
    let text = ""
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: Omit<BuildResult, "ms" | "graph">) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (!hadOutput) excludeOutput(root)
      resolve({ ...result, ms: Date.now() - started, graph })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { cwd: out, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    } catch (error) {
      finish({ ok: false, files: 0, nodes: 0, edges: 0, error: error instanceof Error ? error.message : String(error) })
      return
    }
    if (options.timeoutMs)
      timer = setTimeout(() => {
        child.kill()
        finish({ ok: false, ...parseOutput(text), error: `stopped after ${Math.round(options.timeoutMs! / 1000)} s` })
      }, options.timeoutMs)
    const read = (chunk: Buffer) => {
      const value = chunk.toString("utf8")
      text += value
      for (const line of value.split(/\r?\n/)) if (line.trim()) options.onLine?.(line.trim())
    }
    child.stdout?.on("data", read)
    child.stderr?.on("data", read)
    child.on("error", (error) => finish({ ok: false, files: 0, nodes: 0, edges: 0, error: error.message }))
    child.on("close", (code) => {
      const parsed = parseOutput(text)
      if (code === 0 && fs.existsSync(graph)) return finish({ ok: true, ...parsed })
      const last = text.trim().split(/\r?\n/).slice(-1)[0] ?? ""
      finish({ ok: false, ...parsed, error: `graphify exited with code ${code}${last ? `: ${last}` : ""}` })
    })
  })
}

// Lists graphify-out/ in .git/info/exclude (never .gitignore) when it exists in the project.
export function excludeOutput(root: string) {
  try {
    if (!fs.existsSync(path.join(root, "graphify-out"))) return false
    const info = path.join(root, ".git", "info")
    if (!fs.statSync(path.join(root, ".git")).isDirectory()) return false
    fs.mkdirSync(info, { recursive: true })
    const file = path.join(info, "exclude")
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
    if (current.split(/\r?\n/).includes("graphify-out/")) return false
    fs.appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}graphify-out/\n`)
    return true
  } catch {
    return false
  }
}

export function summary(result: BuildResult) {
  const seconds = (result.ms / 1000).toFixed(1)
  if (!result.ok) return `Project map not built (${result.error ?? "unknown error"}).`
  return `Project map ready: ${result.files} code files, ${result.nodes} names, ${result.edges} links, ${seconds} s.`
}
