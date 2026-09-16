// Unlisted tiers (Brand.provider.unlisted): rafiki-max is left out of the
// model lists people choose from (rafikicode models, the terminal interface
// picker, the model option an editor gets over ACP) while its provider is
// unavailable. The tier stays registered, so an explicit choice still reaches
// the gateway, and an empty list offers every tier again.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as RafikiACP from "../../src/rafiki/acp"
import * as MissingKey from "../../src/rafiki/missing-key"
import { buildConfigOptions } from "../../src/acp/config-option"
import { createMockGateway } from "./mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const defaultUnlisted = Brand.provider.unlisted

afterEach(() => {
  Brand.provider.unlisted = defaultUnlisted
})

const providers = [
  {
    id: "rafiki",
    name: "Rafiki",
    models: {
      "rafiki-fast": { id: "rafiki-fast", name: "Rafiki Fast" },
      "rafiki-pro": { id: "rafiki-pro", name: "Rafiki Pro" },
      "rafiki-max": { id: "rafiki-max", name: "Rafiki Max", variants: { high: {} } },
    },
  },
]

function modelValues(options: ReturnType<typeof buildConfigOptions>) {
  const option = options.find((item) => item.id === "model") as any
  return { current: option.currentValue, values: option.options.map((item: any) => item.value) }
}

describe("the switch", () => {
  test("rafiki-max is unlisted by default; fast and pro are offered", () => {
    expect([...Brand.provider.unlisted]).toEqual(["rafiki-max"])
    expect(Brand.provider.listed("rafiki", "rafiki-max")).toBe(false)
    expect(Brand.provider.listed("rafiki", "rafiki-fast")).toBe(true)
    expect(Brand.provider.listed("rafiki", "rafiki-pro")).toBe(true)
    expect(Brand.provider.listed("other", "rafiki-max")).toBe(true)
    expect(Brand.provider.offered()).toEqual(["rafiki-fast", "rafiki-pro"])
  })

  test("an empty list offers every tier again", () => {
    Brand.provider.unlisted = []
    expect(Brand.provider.listed("rafiki", "rafiki-max")).toBe(true)
    expect(Brand.provider.offered()).toEqual(["rafiki-fast", "rafiki-pro", "rafiki-max"])
    expect(MissingKey.outOfScope()).toContain("(rafiki-fast, rafiki-pro, rafiki-max)")
  })

  test("the tier stays registered with the gateway provider", () => {
    const saved = process.env[Brand.env.apiKey]
    process.env[Brand.env.apiKey] = "sk-stub-unlisted-0001"
    try {
      const provider = Brand.provider.config().rafiki
      expect(Object.keys(provider.models)).toEqual(["rafiki-fast", "rafiki-pro", "rafiki-max"])
    } finally {
      if (saved === undefined) delete process.env[Brand.env.apiKey]
      else process.env[Brand.env.apiKey] = saved
    }
  })

  test("the out of scope message names the offered tiers", () => {
    expect(MissingKey.outOfScope()).toBe(
      "rafikicode runs on Rafiki models only (rafiki-fast, rafiki-pro). Run rafikicode models to see them.",
    )
  })
})

describe("the ACP model option", () => {
  const fast = { providerID: "rafiki", modelID: "rafiki-fast" }
  const max = { providerID: "rafiki", modelID: "rafiki-max" }

  test("leaves rafiki-max out", () => {
    const listed = RafikiACP.listedProviders(providers, fast)
    expect(Object.keys(listed[0]!.models)).toEqual(["rafiki-fast", "rafiki-pro"])
    const option = modelValues(buildConfigOptions({ providers: listed, currentModel: fast }))
    expect(option).toEqual({ current: "rafiki/rafiki-fast", values: ["rafiki/rafiki-fast", "rafiki/rafiki-pro"] })
    // The input is not changed: lookups keep every model.
    expect(Object.keys(providers[0]!.models)).toContain("rafiki-max")
  })

  test("keeps rafiki-max, with its effort levels, when the session already uses it", () => {
    const listed = RafikiACP.listedProviders(providers, max)
    const options = buildConfigOptions({ providers: listed, currentModel: max })
    expect(modelValues(options)).toEqual({
      current: "rafiki/rafiki-max",
      values: ["rafiki/rafiki-fast", "rafiki/rafiki-max", "rafiki/rafiki-pro"],
    })
    expect(options.find((item) => item.id === "effort")).toBeTruthy()
  })

  test("offers every tier when the switch is empty", () => {
    Brand.provider.unlisted = []
    const listed = RafikiACP.listedProviders(providers, fast)
    expect(Object.keys(listed[0]!.models)).toEqual(["rafiki-fast", "rafiki-pro", "rafiki-max"])
  })
})

describe("the terminal interface picker", () => {
  test("the model dialog filters through the brand switch and keeps the current model", () => {
    const text = fs.readFileSync(path.resolve(root, "../tui/src/component/dialog-model.tsx"), "utf8")
    expect(text).toContain("Brand.provider.listed(providerID, modelID)")
    expect(text).toContain("filter(([model]) => listed(provider.id, model))")
    expect(text).toContain("if (!model || !listed(provider.id, model.id)) return []")
  })
})

describe("an explicit rafiki-max still runs", () => {
  test("run --model rafiki/rafiki-max sends rafiki-max to the gateway", async () => {
    const gateway = createMockGateway({ quiet: true })
    await gateway.ready
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-unlisted-"))
    try {
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: home,
        OPENCODE_TEST_HOME: home,
        XDG_DATA_HOME: path.join(home, ".local/share"),
        XDG_STATE_HOME: path.join(home, ".local/state"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_PURE: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        [Brand.env.apiKey]: "sk-stub-unlisted-0002",
        [Brand.env.gatewayURL]: gateway.url + "/v1",
      }
      for (const name of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", Brand.providers.testEnv])
        delete env[name]
      const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "run", "--model", "rafiki/rafiki-max", "hello"], {
        cwd: home,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: env as Record<string, string>,
      })
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      const code = await proc.exited
      expect({ code, stderr }).toMatchObject({ code: 0 })
      expect(stdout).toContain("Mock gateway reply")
      const calls = gateway.requests.filter((r: any) => r.path === "/v1/chat/completions")
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.some((r: any) => r.model === "rafiki-max")).toBe(true)
      expect(calls.every((r: any) => r.status === 200)).toBe(true)
    } finally {
      await gateway.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  }, 120_000)
})
