// Request defaults for the rafiki-* models, and the message for a turn that
// ends empty on its output limit. rafiki-fast is a reasoning model: with a
// tiny output cap it can spend every token reasoning and answer nothing, and
// a streamed "low" effort reasons as much as no effort at all, so the default
// sends none and the none variant turns reasoning off (measured on the
// gateway, 2026-09-13).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import { EMPTY_LENGTH_MESSAGE, emptyLengthError, isEmptyLengthTurn } from "../../src/rafiki/reasoning"
import { ProviderTransform } from "../../src/provider/transform"
import { createMockGateway } from "./mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const saved = { ...process.env }

afterEach(() => {
  for (const name of [Brand.env.maxOutputTokens, Brand.env.reasoningEffort]) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

function models() {
  return (Brand.provider.config() as any)[Brand.provider.id].models as Record<string, any>
}

describe("rafiki model request defaults", () => {
  test("fast gets 64000 output tokens and no effort, pro and max 32000, effort variants where the gateway accepted them", () => {
    delete process.env[Brand.env.maxOutputTokens]
    delete process.env[Brand.env.reasoningEffort]
    const m = models()
    expect(m["rafiki-fast"].limit.output).toBe(64_000)
    expect(m["rafiki-pro"].limit.output).toBe(32_000)
    expect(m["rafiki-max"].limit.output).toBe(32_000)
    expect(m["rafiki-fast"].options).toBeUndefined()
    expect(m["rafiki-fast"].variants.none).toEqual({ reasoningEffort: "none" })
    expect(m["rafiki-pro"].options).toBeUndefined()
    expect(m["rafiki-max"].options).toBeUndefined()
    const variants = Object.fromEntries(Brand.provider.reasoningEfforts.map((e) => [e, { reasoningEffort: e }]))
    expect(m["rafiki-fast"].variants).toEqual(variants)
    expect(m["rafiki-max"].variants).toEqual(variants)
    expect(m["rafiki-pro"].variants).toBeUndefined()
  })

  test("the env names override every tier, and invalid values fall back to the defaults", () => {
    process.env[Brand.env.maxOutputTokens] = "48000"
    process.env[Brand.env.reasoningEffort] = "none"
    let m = models()
    for (const id of Brand.models) {
      expect(m[id].limit.output).toBe(48_000)
      expect(m[id].options).toEqual({ reasoningEffort: "none" })
    }
    process.env[Brand.env.reasoningEffort] = "default"
    process.env[Brand.env.maxOutputTokens] = "16"
    m = models()
    expect(m["rafiki-fast"].options).toBeUndefined()
    expect(m["rafiki-fast"].limit.output).toBe(64_000)
    process.env[Brand.env.reasoningEffort] = "extreme"
    process.env[Brand.env.maxOutputTokens] = "12k"
    m = models()
    expect(m["rafiki-fast"].options).toBeUndefined()
    expect(m["rafiki-fast"].limit.output).toBe(64_000)
    expect(m["rafiki-pro"].limit.output).toBe(32_000)
  })

  test("the rafiki provider is held to its own output limit, not the upstream 32000 cap; an explicit cap still wins", () => {
    const fast = { providerID: Brand.provider.id, limit: { context: 128_000, output: 64_000 } } as any
    const other = { providerID: "openai", limit: { context: 400_000, output: 128_000 } } as any
    expect(ProviderTransform.maxOutputTokens(fast)).toBe(64_000)
    expect(ProviderTransform.maxOutputTokens(fast, 20_000)).toBe(20_000)
    expect(ProviderTransform.maxOutputTokens(other)).toBe(ProviderTransform.OUTPUT_TOKEN_MAX)
  })

  test("an empty turn that stopped on length gets a clear error; text, tools and other providers do not", () => {
    const reasoningOnly = [{ type: "reasoning", text: "thinking" }, { type: "step-finish" }]
    expect(isEmptyLengthTurn("length", reasoningOnly)).toBe(true)
    expect(isEmptyLengthTurn("length", [{ type: "text", text: "   " }])).toBe(true)
    expect(isEmptyLengthTurn("length", [{ type: "text", text: "partial answer" }])).toBe(false)
    expect(isEmptyLengthTurn("length", [{ type: "tool" }])).toBe(false)
    expect(isEmptyLengthTurn("stop", [])).toBe(false)
    const error = emptyLengthError({ providerID: "rafiki", finish: "length" }, reasoningOnly) as any
    expect(error.name).toBe("UnknownError")
    expect(error.data.message).toBe(EMPTY_LENGTH_MESSAGE)
    expect(EMPTY_LENGTH_MESSAGE).toContain("--variant none")
    expect(EMPTY_LENGTH_MESSAGE).toContain(`${Brand.env.reasoningEffort}=none`)
    expect(EMPTY_LENGTH_MESSAGE).not.toMatch(/deepseek|rafiki-fast|opencode/i)
    expect(emptyLengthError({ providerID: "openai", finish: "length" }, reasoningOnly)).toBeUndefined()
    expect(emptyLengthError({ providerID: "rafiki", finish: "length", error: { name: "APIError" } }, reasoningOnly)).toBeUndefined()
  })
})

describe("rafikicode run against the mock gateway", () => {
  let home: string
  let gateway: ReturnType<typeof createMockGateway> | undefined

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-reasoning-"))
  })

  afterEach(async () => {
    await gateway?.close()
    gateway = undefined
    fs.rmSync(home, { recursive: true, force: true })
  })

  async function run(args: string[], extra: Record<string, string> = {}) {
    const env: Record<string, string | undefined> = {
      ...process.env,
      COLUMNS: "120",
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      RAFIKICODE_GATEWAY_URL: gateway!.url + "/v1",
      RAFIKICODE_API_KEY: "sk-stub-not-a-secret",
      ...extra,
    }
    for (const name of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", Brand.env.maxOutputTokens, Brand.env.reasoningEffort]) {
      if (!(name in extra)) delete env[name]
    }
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), ...args], {
      cwd: home,
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { exitCode: await proc.exited, all: stdout + stderr }
  }

  const promptCalls = (marker: string) =>
    gateway!.requests.filter((r: any) => r.path === "/v1/chat/completions" && String(r.last_user ?? "").includes(marker))

  test("the prompt carries the full output limit and no effort; the none variant and the env names change them", async () => {
    gateway = createMockGateway({ quiet: true })
    await gateway.ready
    const plain = await run(["run", "defaults check"])
    expect(plain.exitCode).toBe(0)
    const plainCall = promptCalls("defaults check").at(-1) as any
    expect(plainCall).toMatchObject({ model: "rafiki-fast", max_tokens: 64_000 })
    expect(plainCall.reasoning_effort).toBeUndefined()
    for (const call of gateway.requests.filter((r: any) => r.path === "/v1/chat/completions")) {
      if ((call as any).max_tokens !== undefined) expect((call as any).max_tokens).toBeGreaterThanOrEqual(1_024)
    }

    await run(["run", "--variant", "none", "variant check"])
    expect(promptCalls("variant check").at(-1)).toMatchObject({ reasoning_effort: "none" })

    await run(["run", "env check"], { [Brand.env.maxOutputTokens]: "8000", [Brand.env.reasoningEffort]: "default" })
    const tuned = promptCalls("env check").at(-1) as any
    expect(tuned.max_tokens).toBe(8_000)
    expect(tuned.reasoning_effort).toBeUndefined()
  }, 120_000)

  test("a turn that ends empty on length prints the clear message instead of going quiet", async () => {
    gateway = createMockGateway({ quiet: true, emptyLength: true })
    await gateway.ready
    const result = await run(["run", "empty check"])
    expect(result.all).toContain("whole output budget reasoning and wrote no answer")
    expect(result.all).toContain(Brand.env.maxOutputTokens)
    expect(result.all).toContain("--variant none")
    // One agent turn (the call with tools); the title call carries the same text and no tools.
    expect(promptCalls("empty check").filter((r: any) => r.tools > 0).length).toBe(1)
  }, 120_000)
})
