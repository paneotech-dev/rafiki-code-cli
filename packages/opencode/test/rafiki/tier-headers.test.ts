// Every request to the gateway names its tier and whether it is an
// escalation, next to the surface: X-Rafiki-Tier and X-Rafiki-Escalation,
// checked on the wire against the mock gateway and in the provider config.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Contract from "../../src/rafiki/contract"
import { createMockConsole } from "../brand/mock-console.mjs"
import { createMockGateway } from "../brand/mock-gateway.mjs"
import { spawnCli } from "./spawn"

let home: string
let console_: ReturnType<typeof createMockConsole>
let gateway: ReturnType<typeof createMockGateway>

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-tier-"))
  gateway = createMockGateway({ quiet: true })
  console_ = createMockConsole({ quiet: true, anyKey: true })
  await Promise.all([gateway.ready, console_.ready])
})

afterEach(async () => {
  await console_.close()
  await gateway.close()
  fs.rmSync(home, { recursive: true, force: true })
})

const run = (args: string[]) =>
  spawnCli(home, args, {
    RAFIKICODE_API_KEY: "sk-test-not-a-real-key",
    RAFIKICODE_GATEWAY_URL: gateway.url + "/v1",
    RAFIKICODE_CONSOLE_URL: console_.url,
  })

const chatCalls = () => gateway.requests.filter((r: any) => r.path === "/v1/chat/completions")

describe("tier and escalation headers", () => {
  test("the header names sit next to the surface header", () => {
    expect(Contract.HEADER).toEqual({ surface: "X-Rafiki-Surface", tier: "X-Rafiki-Tier", escalation: "X-Rafiki-Escalation" })
  })

  test("every tier's model entry carries its own tier and escalation 0", () => {
    const previous = process.env[Brand.env.apiKey]
    process.env[Brand.env.apiKey] = "sk-test-not-a-real-key"
    try {
      const provider = Brand.provider.config().rafiki
      expect(provider.options.headers).toEqual({ "X-Rafiki-Surface": "cli" })
      for (const tier of ["fast", "pro", "max"]) {
        expect(provider.models[`rafiki-${tier}`]!.headers).toEqual({ "X-Rafiki-Tier": tier, "X-Rafiki-Escalation": "0" })
      }
    } finally {
      if (previous === undefined) delete process.env[Brand.env.apiKey]
      else process.env[Brand.env.apiKey] = previous
    }
  })

  test("a run on the default tier sends fast and 0 on every request", async () => {
    const result = await run(["run", "say hello"])
    expect(result.exitCode).toBe(0)
    const calls = chatCalls()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call).toMatchObject({ model: "rafiki-fast", surface: "cli", tier: "fast", escalation: "0" })
    }
  }, 60_000)

  test("a run on pro sends pro on its requests; a request made on another alias names that alias's tier", async () => {
    const result = await run(["run", "--model", "rafiki/rafiki-pro", "say hello"])
    expect(result.exitCode).toBe(0)
    const calls = chatCalls()
    expect(calls.some((call: any) => call.model === "rafiki-pro")).toBe(true)
    for (const call of calls) {
      expect(call.surface).toBe("cli")
      expect(call.tier).toBe(call.model.replace("rafiki-", ""))
      expect(call.escalation).toBe("0")
    }
  }, 60_000)
})
