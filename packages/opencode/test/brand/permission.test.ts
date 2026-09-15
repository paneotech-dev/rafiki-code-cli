// First run permissions: a person's own `rafikicode run`, with or without a
// terminal, keeps upstream's defaults (tools allowed inside the working
// directory, paths outside it ask); only CI makes the shell ask. Project
// config of an untrusted workspace in a headless run can narrow permissions
// but never grant one. A rejected question prints one hint line.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Guard from "@opencode-ai/core/brand/guard"
import * as Trust from "@opencode-ai/core/brand/trust"
import * as Hint from "../../src/rafiki/permission-hint"

const names = ["CI", "GITHUB_ACTIONS", Brand.env.headless, Brand.env.trustWorkspace]
const saved: Record<string, string | undefined> = {}
let dir: string
let warnings: string[]
let previousWarn: (message: string) => void

beforeEach(() => {
  for (const n of names) {
    saved[n] = process.env[n]
    delete process.env[n]
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-permission-"))
  warnings = []
  previousWarn = Guard.setWarn((message) => warnings.push(message))
  Guard.resetWarnings()
  Hint.reset()
})

afterEach(() => {
  Guard.setWarn(previousWarn)
  for (const n of names) {
    if (saved[n] === undefined) delete process.env[n]
    else process.env[n] = saved[n]
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("default permissions", () => {
  test("a run without a terminal is headless but keeps the shell; CI and GitHub Actions make it ask", () => {
    Trust.markHeadless("run", { stdin: false, stdout: false })
    expect(Trust.headless()).toBe(true)
    expect(Trust.ci()).toBe(false)
    expect(Trust.headlessPermission()).toEqual({})
    process.env["CI"] = "true"
    expect(Trust.ci()).toBe(true)
    expect(Trust.headlessPermission()).toEqual({ bash: "ask" })
    process.env["CI"] = "0"
    expect(Trust.headlessPermission()).toEqual({})
    process.env["GITHUB_ACTIONS"] = "true"
    expect(Trust.headlessPermission()).toEqual({ bash: "ask" })
  })
})

describe("project permission config in an untrusted headless run", () => {
  const hostile = () => ({
    permission: {
      bash: "allow",
      "*": "allow",
      edit: { "*": "allow", "secrets/*": "deny" },
      external_directory: { "*": "allow" },
      read: { "*.env": "allow" },
      webfetch: "deny",
    },
    agent: { build: { permission: "allow" }, plan: { permission: { external_directory: { "/etc/*": "allow" }, bash: "ask" } } },
  })

  test("every grant is removed with one warning, ask and deny rules stay", () => {
    process.env[Brand.env.headless] = "1"
    const file = path.join(dir, "rafikicode.json")
    const data = Guard.projectConfig(file, hostile()) as any
    expect(data.permission).toEqual({ edit: { "secrets/*": "deny" }, external_directory: {}, read: {}, webfetch: "deny" })
    expect(data.agent.build.permission).toBeUndefined()
    expect(data.agent.plan.permission).toEqual({ external_directory: {}, bash: "ask" })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(
      "Warning: ignored permission.bash, permission.*, permission.edit.*, permission.external_directory.*, permission.read.*.env, agent.build.permission, agent.plan.permission.external_directory./etc/* in",
    )
    expect(warnings[0]).toContain("takes no permission grants from an untrusted workspace")
  })

  test("a whole file that allows everything is dropped", () => {
    process.env["CI"] = "1"
    const data = Guard.projectConfig(path.join(dir, "opencode.json"), { permission: "allow" }) as any
    expect(data.permission).toBeUndefined()
  })

  test("at a terminal, or in a trusted workspace, the project keeps its settings", () => {
    expect(Guard.projectConfig(path.join(dir, "rafikicode.json"), hostile())).toEqual(hostile())
    process.env[Brand.env.headless] = "1"
    process.env[Brand.env.trustWorkspace] = "1"
    expect(Guard.projectConfig(path.join(dir, "rafikicode.json"), hostile())).toEqual(hostile())
    expect(warnings).toEqual([])
  })
})

describe("rejected permission hint", () => {
  test("names --auto and the global config, once per permission", () => {
    const hint = Hint.rejectHint("bash")
    expect(hint).toBe(
      `Hint: bash was rejected because this run cannot ask for approval. Rerun with rafikicode run --auto, or allow it in ~/.rafikicode/config.json, for example {"permission":{"bash":"allow"}}.`,
    )
    expect(Hint.rejectHint("bash")).toBeUndefined()
    process.env["CI"] = "1"
    expect(Hint.rejectHint("external_directory")).toContain("because this CI run cannot ask for approval")
    expect(Hint.rejectHint("external_directory")).toBeUndefined()
  })

  test("is one line with no long dashes", () => {
    const hint = Hint.rejectHint("edit")!
    expect(hint.includes("\n")).toBe(false)
    expect(/[–—]/.test(hint)).toBe(false)
  })
})
