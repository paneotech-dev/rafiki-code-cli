// The project map (src/brand/project-map.ts): off by default, the setting and
// RAFIKICODE_MAP, finding graphify (PATH, python3, the Windows py launcher),
// the install line when it is missing, the graph kept outside the project,
// no provider variable reaching graphify, and the tool filter.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "../../src/brand/brand"
import * as ProjectMap from "../../src/brand/project-map"

let project: string
let cache: string

beforeEach(() => {
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-map-project-")))
  cache = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-map-cache-")))
})

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true })
  fs.rmSync(cache, { recursive: true, force: true })
})

const none = () => null
const only =
  (found: Record<string, string>) =>
  (cmd: string): string | null =>
    found[cmd] ?? null

describe("on and off", () => {
  test("off by default", () => {
    expect(ProjectMap.enabled(undefined, undefined)).toBe(false)
    expect(ProjectMap.enabled({}, undefined)).toBe(false)
    expect(ProjectMap.enabled({ graphify: false }, undefined)).toBe(false)
  })

  test("the setting turns it on", () => {
    expect(ProjectMap.enabled({ graphify: true }, undefined)).toBe(true)
  })

  test("RAFIKICODE_MAP wins over the setting", () => {
    expect(ProjectMap.enabled(undefined, "1")).toBe(true)
    expect(ProjectMap.enabled({ graphify: false }, "on")).toBe(true)
    expect(ProjectMap.enabled({ graphify: true }, "0")).toBe(false)
    expect(ProjectMap.enabled({ graphify: true }, "off")).toBe(false)
    // An unreadable value leaves the setting in charge.
    expect(ProjectMap.enabled({ graphify: true }, "maybe")).toBe(true)
    expect(ProjectMap.enabled(undefined, " ")).toBe(false)
  })

  test("the variable name matches the brand table", () => {
    expect(ProjectMap.ENV).toBe(Brand.env.map)
  })
})

describe("finding graphify", () => {
  test("graphify and graphify-mcp on PATH are used as they are", () => {
    const probes: string[][] = []
    const launcher = ProjectMap.detect({
      platform: "linux",
      which: only({ graphify: "/home/a/.local/bin/graphify", "graphify-mcp": "/home/a/.local/bin/graphify-mcp" }),
      probe: (cmd) => (probes.push(cmd), true),
    })
    expect(launcher).toEqual({
      via: "path",
      cli: ["/home/a/.local/bin/graphify"],
      mcp: ["/home/a/.local/bin/graphify-mcp"],
    })
    expect(probes).toEqual([])
  })

  test("else python3 -m graphify when the module and the mcp extra import", () => {
    const probes: string[][] = []
    const launcher = ProjectMap.detect({
      platform: "darwin",
      which: only({ python3: "/usr/bin/python3" }),
      probe: (cmd) => (probes.push(cmd), true),
    })
    expect(launcher).toEqual({
      via: "python",
      cli: ["/usr/bin/python3", "-m", "graphify"],
      mcp: ["/usr/bin/python3", "-m", "graphify.serve"],
    })
    expect(probes).toEqual([["/usr/bin/python3", "-c", "import graphify.serve, mcp"]])
  })

  test("Windows tries the py launcher first, then python", () => {
    const probes: string[][] = []
    const py = "C:\\Windows\\py.exe"
    const python = "C:\\Program Files\\Python312\\python.exe"
    const launcher = ProjectMap.detect({
      platform: "win32",
      which: only({ py, python }),
      probe: (cmd) => (probes.push(cmd), cmd[0] === python),
    })
    expect(probes.map((cmd) => cmd[0])).toEqual([py, python])
    expect(probes[0].slice(0, 2)).toEqual([py, "-3"])
    // A path with spaces stays one argument.
    expect(launcher?.mcp).toEqual([python, "-m", "graphify.serve"])
  })

  test("only one of the two commands on PATH falls back to Python", () => {
    const launcher = ProjectMap.detect({
      platform: "linux",
      which: only({ graphify: "/usr/local/bin/graphify", python3: "/usr/bin/python3" }),
      probe: () => true,
    })
    expect(launcher?.via).toBe("python")
  })

  test("missing when nothing is found or Python lacks the module", () => {
    expect(ProjectMap.detect({ platform: "linux", which: none, probe: () => true })).toBeUndefined()
    expect(
      ProjectMap.detect({ platform: "linux", which: only({ python3: "/usr/bin/python3" }), probe: () => false }),
    ).toBeUndefined()
    expect(ProjectMap.detect({ platform: "win32", which: none, probe: () => true })).toBeUndefined()
  })

  test("the probe of a command that does not exist is false, not a throw", () => {
    expect(ProjectMap.defaultProbe([path.join(project, "no-such-python"), "-c", "pass"])).toBe(false)
  })
})

describe("missing graphify", () => {
  test("one install line per system, uv then pipx then pip", () => {
    expect(ProjectMap.installCommand("linux", only({ uv: "/x/uv" }))).toBe('uv tool install "graphifyy[mcp]"')
    expect(ProjectMap.installCommand("win32", only({ pipx: "C:\\pipx.exe" }))).toBe('pipx install "graphifyy[mcp]"')
    expect(ProjectMap.installCommand("win32", none)).toBe('py -m pip install --user "graphifyy[mcp]"')
    expect(ProjectMap.installCommand("darwin", none)).toBe('python3 -m pip install --user "graphifyy[mcp]"')
    expect(ProjectMap.installCommand("linux", none)).toBe('python3 -m pip install --user "graphifyy[mcp]"')
  })

  test("the message is one line with the command", () => {
    const message = ProjectMap.missingMessage("linux", none)
    expect(message).not.toContain("\n")
    expect(message).toContain('python3 -m pip install --user "graphifyy[mcp]"')
    expect(message).not.toMatch(/\bRafiki\b(?! AI)/)
  })
})

describe("where the graph lives", () => {
  test("in the cache folder, one folder per project, never in the project", () => {
    const out = ProjectMap.outDir(project, cache)
    expect(out.startsWith(path.join(cache, "project-map") + path.sep)).toBe(true)
    expect(out.startsWith(project)).toBe(false)
    expect(ProjectMap.outDir(project + path.sep, cache)).toBe(out)
    expect(ProjectMap.outDir(path.join(project, "other"), cache)).not.toBe(out)
    expect(ProjectMap.graphFile(project, cache)).toBe(path.join(out, "graphify-out", "graph.json"))
  })
})

describe("nothing leaves the machine", () => {
  test("no backend, no query log, output in the cache, provider variables blanked", () => {
    const env = ProjectMap.graphifyEnv(project, cache, {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "x",
      ANTHROPIC_API_KEY: "x",
      GEMINI_API_KEY: "x",
      GITHUB_TOKEN: "x",
      OLLAMA_BASE_URL: "http://localhost:11434",
      AWS_ACCESS_KEY_ID: "x",
    })
    expect(env.GRAPHIFY_BACKEND).toBe("none")
    expect(env.GRAPHIFY_QUERY_LOG_DISABLE).toBe("1")
    expect(env.GRAPHIFY_OUT).toBe(path.join(ProjectMap.outDir(project, cache), "graphify-out"))
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GITHUB_TOKEN", "OLLAMA_BASE_URL", "AWS_ACCESS_KEY_ID"])
      expect(env[name]).toBe("")
    expect(env.PATH).toBeUndefined()
  })

  test("the MCP entry serves the cached graph from the cache folder", () => {
    const launcher: ProjectMap.Launcher = { via: "python", cli: ["py", "-m", "graphify"], mcp: ["py", "-m", "graphify.serve"] }
    const entry = ProjectMap.mcpEntry(launcher, project, cache, {})
    expect(entry.type).toBe("local")
    expect(entry.command).toEqual(["py", "-m", "graphify.serve", ProjectMap.graphFile(project, cache)])
    expect(entry.cwd).toBe(ProjectMap.outDir(project, cache))
    expect(entry.environment.GRAPHIFY_BACKEND).toBe("none")
    expect(ProjectMap.isOurs(entry)).toBe(true)
    expect(ProjectMap.isOurs({ environment: {} })).toBe(false)
    expect(ProjectMap.isOurs(undefined)).toBe(false)
  })

  test("only the code graph tools pass, with short descriptions; the pull request tools do not", () => {
    const defs = [
      "query_graph",
      "get_node",
      "get_neighbors",
      "get_community",
      "god_nodes",
      "graph_stats",
      "shortest_path",
      "list_prs",
      "get_pr_impact",
      "triage_prs",
    ].map((name) => ({
      name,
      description: "long",
      inputSchema: {
        type: "object",
        properties: { question: {}, mode: {}, depth: {}, token_budget: {}, context_filter: {}, demote_docs: {} },
      },
    }))
    const kept = ProjectMap.filterTools(defs)
    expect(kept.map((def) => def.name).sort()).toEqual([...ProjectMap.TOOLS].sort())
    for (const def of kept) expect(def.description).toContain("Project map")
    const query = kept.find((def) => def.name === "query_graph")!
    expect(Object.keys(query.inputSchema.properties)).toEqual(["question", "mode", "depth", "token_budget"])
  })
})

describe("building", () => {
  test("progress lines give files, names and links", () => {
    const text = [
      "[graphify extract] found 12 code, 0 docs, 0 papers, 0 images",
      "[graphify extract] wrote /c/graphify-out/graph.json: 40 nodes, 52 edges, 3 communities",
    ].join("\n")
    expect(ProjectMap.parseOutput(text)).toEqual({ files: 12, nodes: 40, edges: 52 })
    expect(ProjectMap.parseOutput("nothing")).toEqual({ files: 0, nodes: 0, edges: 0 })
    // A refresh prints no "found" line: the files are those cached plus those read again.
    const refresh = [
      "[graphify extract] incremental summary: 11 files cached/unchanged, 1 re-extracted, 0 deleted",
      "[graphify extract] wrote /c/graphify-out/graph.json: 40 nodes, 52 edges, 3 communities",
    ].join("\n")
    expect(ProjectMap.parseOutput(refresh)).toEqual({ files: 12, nodes: 40, edges: 52 })
  })

  // A stand-in for graphify: checks its arguments and environment, writes the graph to --out.
  function fakeGraphify(body = "") {
    const script = path.join(cache, "fake-graphify.js")
    fs.writeFileSync(
      script,
      `
const fs = require("fs"), path = require("path")
const args = process.argv.slice(2)
const out = args[args.indexOf("--out") + 1]
if (args[0] !== "extract" || !args.includes("--code-only")) { console.error("bad args " + args.join(" ")); process.exit(2) }
if (process.env.GRAPHIFY_BACKEND !== "none") { console.error("backend not off"); process.exit(3) }
if (process.env.OPENAI_API_KEY) { console.error("key leaked"); process.exit(4) }
${body}
fs.mkdirSync(path.join(out, "graphify-out"), { recursive: true })
fs.writeFileSync(path.join(out, "graphify-out", "graph.json"), "{}")
console.log("[graphify extract] found 3 code, 0 docs, 0 papers, 0 images")
console.log("[graphify extract] wrote " + out + "/graphify-out/graph.json: 9 nodes, 11 edges, 2 communities")
`,
    )
    return { via: "python", cli: [process.execPath, script], mcp: [process.execPath, script] } as ProjectMap.Launcher
  }

  test("writes the graph to the cache and nothing into the project", async () => {
    fs.writeFileSync(path.join(project, "a.py"), "def a():\n    pass\n")
    const before = fs.readdirSync(project).sort()
    const lines: string[] = []
    const result = await ProjectMap.build(fakeGraphify(), project, cache, {
      env: { ...process.env, OPENAI_API_KEY: "should-not-pass" },
      onLine: (line) => lines.push(line),
    })
    expect(result.ok).toBe(true)
    expect(result).toMatchObject({ files: 3, nodes: 9, edges: 11 })
    expect(fs.existsSync(ProjectMap.graphFile(project, cache))).toBe(true)
    expect(fs.readdirSync(project).sort()).toEqual(before)
    expect(lines.some((line) => line.includes("found 3 code"))).toBe(true)
    expect(ProjectMap.summary(result)).toMatch(/^Project map ready: 3 code files, 9 names, 11 links, \d+\.\d s\.$/)
  })

  test("a failing run reports its last line", async () => {
    const result = await ProjectMap.build(fakeGraphify('console.error("boom"); process.exit(1)'), project, cache, {})
    expect(result.ok).toBe(false)
    expect(result.error).toContain("boom")
    expect(ProjectMap.summary(result)).toContain("not built")
  })

  test("a run over its time is stopped", async () => {
    const result = await ProjectMap.build(fakeGraphify("Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000)"), project, cache, {
      timeoutMs: 300,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("stopped after")
  })

  test("a stop takes graphify's own child process too", async () => {
    const marker = path.join(cache, "child-still-ran")
    const body = `require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => require('fs').writeFileSync(" + JSON.stringify(${JSON.stringify(marker)}) + ", 'x'), 1500)"], { stdio: "ignore" }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000)`
    const result = await ProjectMap.build(fakeGraphify(body), project, cache, { timeoutMs: 400 })
    expect(result.ok).toBe(false)
    await Bun.sleep(2500)
    expect(fs.existsSync(marker)).toBe(false)
  })

  test("a launcher that does not exist fails cleanly", async () => {
    const launcher: ProjectMap.Launcher = { via: "path", cli: [path.join(project, "missing-graphify")], mcp: [] }
    const result = await ProjectMap.build(launcher, project, cache, {})
    expect(result.ok).toBe(false)
  })

  test("a graphify-out folder left in the project goes in .git/info/exclude, never .gitignore", async () => {
    fs.mkdirSync(path.join(project, ".git", "info"), { recursive: true })
    const result = await ProjectMap.build(
      fakeGraphify('fs.mkdirSync(path.join(process.argv[process.argv.indexOf("extract") + 1], "graphify-out"), { recursive: true })'),
      project,
      cache,
      {},
    )
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(path.join(project, ".git", "info", "exclude"), "utf8")).toContain("graphify-out/")
    expect(fs.existsSync(path.join(project, ".gitignore"))).toBe(false)
    // Once only.
    expect(ProjectMap.excludeOutput(project)).toBe(false)
  })
})
