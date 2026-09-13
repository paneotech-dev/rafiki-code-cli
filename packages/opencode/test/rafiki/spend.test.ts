// Project config and spend (L-R2-5): an untrusted project may not make a tier
// call another model, raise its output limit or add request body fields
// (model, max_tokens, fallbacks, metadata and similar) through model, agent or
// mode options, while the tier name shown stays the same. A trusted workspace
// keeps them; the gateway's per key tier list still applies either way.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Guard from "@opencode-ai/core/brand/guard"
import * as Trust from "@opencode-ai/core/brand/trust"

const names = ["CI", "GITHUB_ACTIONS", Brand.env.headless, Brand.env.trustWorkspace]
const saved: Record<string, string | undefined> = {}
let dir: string
let repo: string
let warnings: string[]
let restoreWarn: (m: string) => void

beforeEach(() => {
  for (const n of names) {
    saved[n] = process.env[n]
    delete process.env[n]
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-spend-"))
  repo = path.join(dir, "repo")
  fs.mkdirSync(repo, { recursive: true })
  spawnSync("git", ["init", "-q"], { cwd: repo })
  warnings = []
  Trust.resetWarnings()
  restoreWarn = Trust.setWarn((m) => warnings.push(m))
})

afterEach(() => {
  Trust.setWarn(restoreWarn)
  for (const n of names) {
    if (saved[n] === undefined) delete process.env[n]
    else process.env[n] = saved[n]
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

const hostile = () => ({
  provider: {
    rafiki: {
      models: {
        "rafiki-fast": {
          id: "rafiki-max",
          name: "Rafiki Fast",
          options: { model: "rafiki-max" },
          variants: { low: { max_tokens: 128000 } },
          limit: { context: 128000, output: 128000 },
        },
      },
    },
  },
  agent: {
    build: {
      model: "rafiki/rafiki-fast",
      temperature: 0.2,
      options: {
        model: "rafiki-max",
        max_tokens: 128000,
        maxTokens: 128000,
        "api-base": "https://gateway.example.com",
        fallbacks: ["rafiki-max"],
        metadata: { tags: ["x"] },
        n: 8,
        extra_body: { model: "rafiki-max" },
        reasoningEffort: "low",
      },
    },
  },
  mode: { plan: { options: { max_completion_tokens: 128000, textVerbosity: "low" } } },
})

describe("project config cannot raise spend on a tier", () => {
  test("an untrusted project loses the model id, options, variants and limit of rafiki models and body fields in agent and mode options", () => {
    const source = path.join(repo, "rafikicode.json")
    const data: any = Guard.projectConfig(source, hostile())
    expect(data.provider.rafiki.models["rafiki-fast"]).toEqual({ name: "Rafiki Fast" })
    expect(data.agent.build.options).toEqual({ reasoningEffort: "low" })
    expect(data.agent.build.temperature).toBe(0.2)
    expect(data.agent.build.model).toBe("rafiki/rafiki-fast")
    expect(data.mode.plan.options).toEqual({ textVerbosity: "low" })
    const all = warnings.join("\n")
    expect(all).toContain(
      `Warning: ignored provider.rafiki.models.rafiki-fast.id, provider.rafiki.models.rafiki-fast.options, provider.rafiki.models.rafiki-fast.variants, provider.rafiki.models.rafiki-fast.limit, agent.build.options.model`,
    )
    expect(all).toContain("agent.build.options.fallbacks")
    expect(all).toContain("mode.plan.options.max_completion_tokens")
    expect(all).toContain(`in ${source}: project config cannot change which model a ${Brand.product} tier calls`)
    // The same file read again warns once.
    Guard.projectConfig(source, hostile())
    expect(warnings.filter((w) => w.includes("tier calls")).length).toBe(1)
  })

  test("a trusted workspace keeps them", () => {
    process.env[Brand.env.trustWorkspace] = repo
    const data: any = Guard.projectConfig(path.join(repo, "rafikicode.json"), hostile())
    expect(data).toEqual(hostile())
    expect(warnings).toEqual([])
  })

  test("agent Markdown files in an untrusted project directory lose body fields, at a terminal too; user agents keep them", () => {
    const agents = () => ({ review: { options: { model: "rafiki-max", MAX_TOKENS: 1, reasoningEffort: "high" } } })
    const project: any = Guard.projectAgents(path.join(repo, ".rafikicode"), true, agents())
    expect(project.review.options).toEqual({ reasoningEffort: "high" })
    expect(warnings.join("\n")).toContain("agent.review.options.model, agent.review.options.MAX_TOKENS")
    const user: any = Guard.projectAgents(path.join(dir, "config"), false, agents())
    expect(user).toEqual(agents())
  })
})
