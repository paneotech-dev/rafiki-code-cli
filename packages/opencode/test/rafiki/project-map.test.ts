// The project map at the start of a session (src/rafiki/project-map.ts): off
// means nothing runs, a hand-made "graphify" MCP entry wins, a missing
// graphify gives the install line, a build gives the MCP entry, and a failed
// first build registers nothing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import * as ProjectMap from "@opencode-ai/core/brand/project-map"
import * as Session from "../../src/rafiki/project-map"

let project: string
let cache: string

beforeEach(() => {
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-map-session-")))
  cache = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-map-cache-")))
})

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true })
  fs.rmSync(cache, { recursive: true, force: true })
})

const launcher: ProjectMap.Launcher = { via: "path", cli: ["graphify"], mcp: ["graphify-mcp"] }

function fakeBuild(ok: boolean, writeGraph: boolean): typeof ProjectMap.build {
  return async (_launcher, root, base) => {
    const graph = ProjectMap.graphFile(root, base)
    if (writeGraph) {
      fs.mkdirSync(path.dirname(graph), { recursive: true })
      fs.writeFileSync(graph, "{}")
    }
    return { ok, files: 2, nodes: 6, edges: 8, ms: 650, graph, error: ok ? undefined : "graphify exited with code 1" }
  }
}

function never(): never {
  throw new Error("must not run when the map is off")
}

describe("project map at session start", () => {
  test("off by default: no detection, no build", async () => {
    const result = await Session.start({
      settings: undefined,
      directory: project,
      configured: false,
      env: {},
      cache,
      detect: never,
      build: never,
    })
    expect(result).toEqual({ kind: "off" })
  })

  test("RAFIKICODE_MAP=0 turns a configured map off", async () => {
    const result = await Session.start({
      settings: { graphify: true },
      directory: project,
      configured: false,
      env: { RAFIKICODE_MAP: "0" },
      cache,
      detect: never,
      build: never,
    })
    expect(result.kind).toBe("off")
  })

  test("a graphify server the person configured is left alone", async () => {
    const result = await Session.start({
      settings: { graphify: true },
      directory: project,
      configured: true,
      env: {},
      cache,
      detect: never,
      build: never,
    })
    expect(result.kind).toBe("configured")
  })

  test("missing graphify: the install line, nothing registered", async () => {
    const result = await Session.start({
      settings: undefined,
      directory: project,
      configured: false,
      env: { RAFIKICODE_MAP: "1", PATH: "" },
      platform: "win32",
      cache,
      detect: () => undefined,
      build: never,
    })
    expect(result.kind).toBe("missing")
    if (result.kind === "missing") expect(result.message).toContain('"graphifyy[mcp]"')
  })

  test("on and installed: the map is built and the MCP entry points at it", async () => {
    const result = await Session.start({
      settings: undefined,
      directory: project,
      configured: false,
      env: { RAFIKICODE_MAP: "1", OPENAI_API_KEY: "x" },
      cache,
      detect: () => launcher,
      build: fakeBuild(true, true),
    })
    expect(result.kind).toBe("ready")
    if (result.kind !== "ready") return
    expect(result.entry.command).toEqual(["graphify-mcp", ProjectMap.graphFile(project, cache)])
    expect(result.entry.environment.GRAPHIFY_BACKEND).toBe("none")
    expect(result.entry.environment.OPENAI_API_KEY).toBe("")
    expect(ProjectMap.isOurs(result.entry)).toBe(true)
    expect(fs.readdirSync(project)).toEqual([])
  })

  test("a failed refresh keeps serving the last graph", async () => {
    const result = await Session.start({
      settings: { graphify: true },
      directory: project,
      configured: false,
      env: {},
      cache,
      detect: () => launcher,
      build: fakeBuild(false, true),
    })
    expect(result.kind).toBe("ready")
  })

  test("a failed first build registers nothing", async () => {
    const result = await Session.start({
      settings: { graphify: true },
      directory: project,
      configured: false,
      env: {},
      cache,
      detect: () => launcher,
      build: fakeBuild(false, false),
    })
    expect(result.kind).toBe("failed")
    if (result.kind === "failed") expect(result.message).toContain("not built")
  })
})
