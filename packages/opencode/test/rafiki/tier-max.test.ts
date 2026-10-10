// rafikicode run --model rafiki/rafiki-max: the price is stated, and a key
// approved without the tier stops the run before any request with a message
// that says so, read from the gateway's /key/info answer (here the mock
// gateway's, for keys registered on it).
import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as TierCheck from "../../src/rafiki/tier-check"
import * as GatewayErrors from "../../src/rafiki/gateway-errors"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const info = (models: string[]) => async () => ({ ok: true as const, info: { spend: 0, maxBudget: null, models }, at: 0 })

describe("the check", () => {
  test("only rafiki/rafiki-max is checked", async () => {
    let asked = 0
    const read = async () => {
      asked++
      return { ok: false as const, at: 0 }
    }
    expect(await TierCheck.refusal("rafiki/rafiki-fast", read)).toBeUndefined()
    expect(await TierCheck.refusal(undefined, read)).toBeUndefined()
    expect(asked).toBe(0)
    expect(await TierCheck.refusal("rafiki/rafiki-max", read)).toBeUndefined()
    expect(asked).toBe(1)
  })

  test("a key without the tier is refused with the fix", async () => {
    const text = await TierCheck.refusal("rafiki/rafiki-max", info(["rafiki-fast", "rafiki-pro"]))
    expect(text).toContain("approved without the Rafiki Max tier")
    expect(text).toContain("rafikicode login again and tick Max")
    expect(await TierCheck.refusal("rafiki/rafiki-max", info(["rafiki-fast", "rafiki-max"]))).toBeUndefined()
    expect(await TierCheck.refusal("rafiki/rafiki-max", info([]))).toBeUndefined()
  })

  test("the price note", () => {
    expect(TierCheck.note("rafiki/rafiki-max")).toBe("Rafiki Max uses 15x credits.")
    expect(TierCheck.note("rafiki/rafiki-fast")).toBeUndefined()
  })

  test("the gateway's own refusal names the fix too", () => {
    const failure = GatewayErrors.classify({
      statusCode: 403,
      responseBody: JSON.stringify({
        error: { type: "key_model_access_denied", message: "key not allowed to access model. This key can only access models=['rafiki-fast']. Tried to access rafiki-max" },
      }),
    })
    expect(failure?.message).toContain("This key is not allowed to use the max tier.")
    expect(failure?.message).toContain("Run rafikicode login again and tick Max on the approval page")
  })
})

function env(home: string, gateway: string, key: string) {
  const out: Record<string, string | undefined> = {
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
    [Brand.env.apiKey]: key,
    [Brand.env.gatewayURL]: gateway + "/v1",
  }
  for (const name of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", Brand.providers.testEnv])
    delete out[name]
  return out as Record<string, string>
}

describe("run against the mock gateway", () => {
  test("a key approved without max stops before any request", async () => {
    const gateway = createMockGateway({ quiet: true })
    await gateway.ready
    await fetch(gateway.url + "/__test/register", {
      method: "POST",
      body: JSON.stringify({ key: "sk-no-max-0001", key_alias: "rafikicode-no-max", models: ["rafiki-fast", "rafiki-pro"] }),
    })
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-max-"))
    try {
      const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "run", "--model", "rafiki/rafiki-max", "hello"], {
        cwd: home,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: env(home, gateway.url, "sk-no-max-0001"),
      })
      const [, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      expect(await proc.exited).toBe(2)
      expect(stderr).toContain("approved without the Rafiki Max tier")
      expect(stderr).toContain("rafikicode login again and tick Max")
      expect(gateway.requests.some((r: any) => r.path === "/key/info")).toBe(true)
      expect(gateway.requests.some((r: any) => r.path === "/v1/chat/completions")).toBe(false)
    } finally {
      await gateway.close()
      fs.rmSync(home, { recursive: true, force: true })
    }
  }, 120_000)
})
