// What rafikicode run prints about the model, the tokens and the cost, driven
// against the mock gateway answering the way the gateway does: OpenAI format
// chunks, prompt_tokens including the cached part, cache writes reported as
// cache_creation_input_tokens, and after a fallback every chunk naming the
// tier that answered. Also the identity the model is given.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { createMockConsole } from "../brand/mock-console.mjs"
import { createMockGateway } from "../brand/mock-gateway.mjs"
import { spawnCli } from "./spawn"

const open: Array<{ close: () => Promise<unknown> }> = []
const homes: string[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()))
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

async function start(options: Record<string, unknown>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-display-"))
  homes.push(home)
  const gateway = createMockGateway({ quiet: true, bodies: true, ...options })
  const console_ = createMockConsole({ quiet: true, anyKey: true })
  open.push(gateway, console_)
  await Promise.all([gateway.ready, console_.ready])
  const run = (args: string[]) =>
    spawnCli(home, args, {
      RAFIKICODE_API_KEY: "sk-test-not-a-real-key",
      RAFIKICODE_GATEWAY_URL: gateway.url + "/v1",
      RAFIKICODE_CONSOLE_URL: console_.url,
    })
  return { gateway, run }
}

// The step_finish events of a run in JSON format: the tokens recorded per call.
function steps(stdout: string) {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === "step_finish")
    .map((event) => event.part.tokens)
}

const fastUsage = {
  prompt_tokens: 24_530,
  completion_tokens: 412,
  total_tokens: 24_942,
  prompt_tokens_details: { cached_tokens: 20_480 },
  completion_tokens_details: { reasoning_tokens: 180 },
}

describe("rafikicode run against a gateway stand-in", () => {
  test("rafiki-fast: header, cached tokens counted once and apart, cost of the tier that answered", async () => {
    const { run } = await start({ usage: fastUsage })
    const text = await run(["run", "who are you"])
    expect(text.exitCode).toBe(0)
    const plain = text.all.replace(/\x1b\[[0-9;]*m/g, "")
    expect(plain).toContain("> build · rafiki-fast")
    expect(plain).not.toContain("was asked for")
    // Mock prices fast 1 / 2 / 0.1 USD per M: 4050 plain input, 20480 cached, 412 output.
    expect(plain).toContain("Task cost: tier fast · about 0.0069 USD (estimate)")

    const json = await run(["run", "--format", "json", "who are you"])
    expect(json.exitCode).toBe(0)
    expect(steps(json.stdout)).toEqual([
      expect.objectContaining({ input: 4_050, output: 232, reasoning: 180, cache: { read: 20_480, write: 0 } }),
    ])
  }, 120_000)

  test("a fallback from fast to pro is announced and costed on pro", async () => {
    const { run } = await start({
      answeredBy: { "rafiki-fast": "rafiki-pro" },
      usage: {
        prompt_tokens: 45_000,
        completion_tokens: 700,
        total_tokens: 45_700,
        prompt_tokens_details: { cached_tokens: 40_000 },
        completion_tokens_details: { reasoning_tokens: 200 },
      },
    })
    const result = await run(["run", "who are you"])
    expect(result.exitCode).toBe(0)
    const plain = result.all.replace(/\x1b\[[0-9;]*m/g, "")
    expect(plain).toContain("> build · rafiki-fast")
    expect(plain).toContain("> build · rafiki-pro (rafiki-fast was asked for, the gateway answered on rafiki-pro)")
    // Mock prices pro 4 / 8 / 1: 5000 plain input, 40000 cached, 700 output. On fast it would read 0.0102.
    expect(plain).toContain("Task cost: tier pro · about 0.0656 USD (estimate)")
  }, 120_000)

  test("rafiki-max: cache writes are recorded as writes and taken out of plain input once", async () => {
    const { run } = await start({
      usage: {
        prompt_tokens: 61_234,
        completion_tokens: 900,
        total_tokens: 62_134,
        prompt_tokens_details: { cached_tokens: 50_000 },
        cache_read_input_tokens: 50_000,
        cache_creation_input_tokens: 8_000,
      },
    })
    const json = await run(["run", "--model", "rafiki/rafiki-max", "--format", "json", "who are you"])
    expect(json.exitCode).toBe(0)
    expect(steps(json.stdout)).toEqual([
      expect.objectContaining({ input: 3_234, output: 900, cache: { read: 50_000, write: 8_000 } }),
    ])
  }, 120_000)

  test("the model is told it is Rafiki Code by PANEOTECH, on the tier it runs on", async () => {
    const { gateway, run } = await start({})
    const result = await run(["run", "who are you"])
    expect(result.exitCode).toBe(0)
    const prompts = (gateway.bodies as Array<{ json: any }>)
      .map((body) => body.json.messages?.find((message: any) => message.role === "system")?.content)
      .map((content) => (typeof content === "string" ? content : JSON.stringify(content)))
    const main = prompts.find((text) => text.includes("You are Rafiki Code, a coding agent"))
    expect(main).toBeDefined()
    expect(main).toStartWith("You are Rafiki Code, a coding agent for the terminal made by PANEOTECH.")
    expect(main).toContain("answer that you are Rafiki Code by PANEOTECH")
    expect(main).toContain("the Rafiki Fast tier (rafiki-fast)")
    expect(main).toContain("You are Rafiki Code, an interactive CLI tool")
    expect(main).not.toContain("You are rafikicode")
  }, 120_000)
})
