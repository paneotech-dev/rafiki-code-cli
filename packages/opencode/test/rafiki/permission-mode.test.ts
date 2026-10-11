// The permission mode (core/brand/permission-mode.ts): the cycle Shift+Tab
// walks, the pick kept per project in the state folder (never in the
// project), where the mode comes from, the config key and its validation, and
// an untrusted project that tries to turn auto mode on.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Schema } from "effect"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Guard from "@opencode-ai/core/brand/guard"
import * as PermissionMode from "@opencode-ai/core/brand/permission-mode"
import { Global } from "@opencode-ai/core/global"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { Permission } from "../../src/permission"

let dir: string
const saved: Record<string, string | undefined> = {}
const vars = [PermissionMode.ENV, Brand.env.trustWorkspace, "OPENCODE_TEST_HOME"]

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-mode-"))
  for (const v of vars) {
    saved[v] = process.env[v]
    delete process.env[v]
  }
  fs.rmSync(PermissionMode.file(), { force: true })
  PermissionMode.setOverride(undefined)
  PermissionMode.useSavedChoice(false)
})

afterEach(() => {
  for (const v of vars) {
    if (saved[v] === undefined) delete process.env[v]
    else process.env[v] = saved[v]
  }
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(PermissionMode.file(), { force: true })
  PermissionMode.setOverride(undefined)
  PermissionMode.useSavedChoice(false)
})

describe("the cycle", () => {
  test("ask, auto, plan, then ask again", () => {
    expect(PermissionMode.next("ask")).toBe("auto")
    expect(PermissionMode.next("auto")).toBe("plan")
    expect(PermissionMode.next("plan")).toBe("ask")
  })
  test("names", () => {
    expect(PermissionMode.MODES.map(PermissionMode.label)).toEqual(["Ask", "Auto", "Plan"])
    expect(PermissionMode.parse(" AUTO ")).toBe("auto")
    expect(PermissionMode.parse("yolo")).toBeUndefined()
  })
})

describe("the pick, per project", () => {
  test("is kept in the state folder, not in the project", () => {
    PermissionMode.save(dir, "auto")
    expect(PermissionMode.file().startsWith(Global.Path.state)).toBe(true)
    expect(fs.existsSync(PermissionMode.file())).toBe(true)
    expect(fs.readdirSync(dir)).toEqual([])
    expect(PermissionMode.savedChoice(dir)?.mode).toBe("auto")
  })
  test("each project keeps its own", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-mode-other-"))
    PermissionMode.save(dir, "plan")
    PermissionMode.save(other, "auto")
    expect(PermissionMode.savedChoice(dir)?.mode).toBe("plan")
    expect(PermissionMode.savedChoice(other)?.mode).toBe("auto")
    // The same folder written another way is the same project.
    expect(PermissionMode.savedChoice(path.join(dir, "sub", ".."))?.mode).toBe("plan")
    fs.rmSync(other, { recursive: true, force: true })
  })
  test("cycling and saving three times comes back to the start", () => {
    let mode = PermissionMode.resolve({ directory: dir, saved: true }).mode
    expect(mode).toBe("ask")
    const seen = [mode]
    for (let i = 0; i < 3; i++) {
      PermissionMode.save(dir, PermissionMode.next(mode))
      mode = PermissionMode.resolve({ directory: dir, saved: true }).mode
      seen.push(mode)
    }
    expect(seen).toEqual(["ask", "auto", "plan", "ask"])
  })
  test("a damaged file reads as no pick", () => {
    fs.mkdirSync(path.dirname(PermissionMode.file()), { recursive: true })
    fs.writeFileSync(PermissionMode.file(), "{not json")
    expect(PermissionMode.savedChoice(dir)).toBeUndefined()
    PermissionMode.save(dir, "plan")
    expect(PermissionMode.savedChoice(dir)?.mode).toBe("plan")
  })
})

describe("where the mode comes from", () => {
  test("the default is ask", () => {
    expect(PermissionMode.resolve({ directory: dir })).toEqual({ mode: "ask", source: "default" })
  })
  test("config", () => {
    expect(PermissionMode.resolve({ directory: dir, config: { mode: "plan", bash: "ask" } })).toEqual({ mode: "plan", source: "config" })
    expect(PermissionMode.resolve({ directory: dir, config: "allow" }).mode).toBe("ask")
  })
  test("the env var wins over config", () => {
    expect(PermissionMode.resolve({ directory: dir, config: { mode: "plan" }, env: { [PermissionMode.ENV]: "auto" } })).toEqual({ mode: "auto", source: "env" })
    expect(PermissionMode.resolve({ directory: dir, env: { [PermissionMode.ENV]: "nonsense" } }).mode).toBe("ask")
  })
  test("an earlier pick wins over config but not over the env var", () => {
    PermissionMode.save(dir, "plan", 1000)
    expect(PermissionMode.resolve({ directory: dir, saved: true, since: 2000, config: { mode: "auto" } })).toEqual({ mode: "plan", source: "saved" })
    expect(PermissionMode.resolve({ directory: dir, saved: true, since: 2000, env: { [PermissionMode.ENV]: "auto" } })).toEqual({ mode: "auto", source: "env" })
  })
  test("a pick made since this process started wins over the env var", () => {
    PermissionMode.save(dir, "plan", 3000)
    expect(PermissionMode.resolve({ directory: dir, saved: true, since: 2000, env: { [PermissionMode.ENV]: "auto" } })).toEqual({ mode: "plan", source: "interface" })
  })
  test("only the interface reads the pick", () => {
    PermissionMode.save(dir, "auto")
    expect(PermissionMode.resolve({ directory: dir }).mode).toBe("ask")
    PermissionMode.useSavedChoice()
    expect(PermissionMode.resolve({ directory: dir }).mode).toBe("auto")
  })
  test("run --auto wins over everything", () => {
    PermissionMode.save(dir, "plan")
    PermissionMode.setOverride("auto")
    expect(PermissionMode.resolve({ directory: dir, saved: true, config: { mode: "plan" }, env: { [PermissionMode.ENV]: "plan" } })).toEqual({ mode: "auto", source: "run" })
  })
})

describe("the config key", () => {
  const decode = Schema.decodeUnknownSync(ConfigPermissionV1.Info)
  test("mode and auto_check are accepted next to rules", () => {
    expect(decode({ mode: "auto", auto_check: false, bash: { "git *": "allow" } })).toEqual({ mode: "auto", auto_check: false, bash: { "git *": "allow" } })
  })
  test("wrong values are refused", () => {
    expect(() => decode({ mode: "yolo" })).toThrow()
    expect(() => decode({ auto_check: "no" })).toThrow()
    expect(() => decode({ bash: "auto" })).toThrow()
    expect(() => decode({ edit: true })).toThrow()
  })
  test("they are settings, not rules", () => {
    expect(Permission.fromConfig({ mode: "auto", auto_check: false, bash: "ask" })).toEqual([{ permission: "bash", pattern: "*", action: "ask" }])
    expect(PermissionMode.fromConfig({ mode: "plan" })).toEqual({ mode: "plan", autoCheck: true })
    expect(PermissionMode.fromConfig({ auto_check: false })).toEqual({ mode: undefined, autoCheck: false })
  })
})

describe("an untrusted project", () => {
  beforeEach(() => {
    Guard.resetTrust()
    Guard.resetWarnings()
  })
  test("cannot turn auto mode on or its risk check off", () => {
    const data = Guard.projectConfig<{ permission: Record<string, unknown> }>(path.join(dir, "rafikicode.json"), { permission: { mode: "auto", auto_check: false, bash: "ask" } })
    expect(data.permission).toEqual({ bash: "ask" })
  })
  test("may pick plan or ask", () => {
    const data = Guard.projectConfig(path.join(dir, "rafikicode.json"), { permission: { mode: "plan" } })
    expect(data.permission).toEqual({ mode: "plan" })
  })
  test("a trusted one may", () => {
    process.env[Brand.env.trustWorkspace] = "1"
    Guard.resetTrust()
    const data = Guard.projectConfig(path.join(dir, "rafikicode.json"), { permission: { mode: "auto", auto_check: false } })
    expect(data.permission).toEqual({ mode: "auto", auto_check: false })
  })
})
