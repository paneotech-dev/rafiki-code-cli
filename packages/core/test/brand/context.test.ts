// The context figure of the terminal interface (src/brand/context.ts): what
// the last request sent, each token counted once, the cached part shown
// beside it and never added to it, what came back apart, the share of the
// window of the tier that answered, and the window named so the share can be
// checked.
import { describe, expect, test } from "bun:test"
import { Brand } from "../../src/brand/brand"
import * as ContextUsage from "../../src/brand/context"

// A rafiki-fast answer as the gateway reports it: prompt_tokens 24530 of which
// 20480 cached, completion_tokens 412 of which 180 reasoning. Recorded split
// (session.getUsage): input 4050, cache read 20480, output 232, reasoning 180.
const fast = { input: 4_050, output: 232, reasoning: 180, cache: { read: 20_480, write: 0 } }

describe("context usage", () => {
  test("sent is what the last request carried, the cached part counted once; received is apart", () => {
    const usage = ContextUsage.usage(fast, 1_000_000)
    expect(usage.sent).toBe(24_530)
    expect(usage.cached).toBe(20_480)
    expect(usage.written).toBe(0)
    expect(usage.received).toBe(412)
    expect(usage.window).toBe(1_000_000)
    expect(usage.percent).toBe("2%")
  })

  test("cache writes are part of what was sent once, not added on top", () => {
    // rafiki-max: prompt_tokens 61234 = 3234 plain + 50000 read + 8000 written.
    const usage = ContextUsage.usage({ input: 3_234, output: 900, reasoning: 0, cache: { read: 50_000, write: 8_000 } }, 1_000_000)
    expect(usage.sent).toBe(61_234)
    expect(usage.cached).toBe(50_000)
    expect(usage.written).toBe(8_000)
    expect(usage.received).toBe(900)
    expect(usage.percent).toBe("6%")
  })

  test("the share is of the window given, so the tier that answered decides it", () => {
    expect(ContextUsage.usage(fast, 128_000).percent).toBe("19%")
    expect(ContextUsage.usage(fast, 1_000_000).percent).toBe("2%")
  })

  test("a share under one per cent reads <1%, nothing reads 0%, and it is never rounded up", () => {
    expect(ContextUsage.percent(5_000, 1_000_000)).toBe("<1%")
    expect(ContextUsage.percent(0, 1_000_000)).toBe("0%")
    expect(ContextUsage.percent(19_990, 1_000_000)).toBe("1%")
    expect(ContextUsage.percent(999_999, 1_000_000)).toBe("99%")
  })

  test("without a window there is no share, and missing or broken counts are zero", () => {
    expect(ContextUsage.usage(fast, undefined)).toEqual({ sent: 24_530, cached: 20_480, written: 0, received: 412 })
    expect(ContextUsage.usage(fast, 0).percent).toBeUndefined()
    expect(ContextUsage.usage(undefined, 1_000_000)).toEqual({ sent: 0, cached: 0, written: 0, received: 0, window: 1_000_000, percent: "0%" })
    expect(ContextUsage.usage({ input: Number.NaN, output: -3, cache: { read: 10, write: 0 } }, 100).sent).toBe(10)
  })

  test("the window is written short", () => {
    expect(ContextUsage.windowText(1_000_000)).toBe("1M")
    expect(ContextUsage.windowText(1_500_000)).toBe("1.5M")
    expect(ContextUsage.windowText(200_000)).toBe("200K")
    expect(ContextUsage.windowText(202_752)).toBe("202,752")
  })
})

describe("the tiers' limits", () => {
  const config = () => {
    const saved = process.env[Brand.env.apiKey]
    process.env[Brand.env.apiKey] = "sk-test"
    try {
      return Brand.provider.config().rafiki.models
    } finally {
      if (saved === undefined) delete process.env[Brand.env.apiKey]
      else process.env[Brand.env.apiKey] = saved
    }
  }

  test("each tier is registered with the window of the model behind it (1M on all three, 2026-10-04)", () => {
    const models = config()
    for (const id of Brand.models) expect(models[id].limit.context).toBe(1_000_000)
  })

  test("the output a request asks for is unchanged, and the override is capped by the tier's upstream maximum", () => {
    const saved = process.env[Brand.env.maxOutputTokens]
    try {
      delete process.env[Brand.env.maxOutputTokens]
      expect(config()["rafiki-fast"].limit.output).toBe(64_000)
      expect(config()["rafiki-pro"].limit.output).toBe(32_000)
      process.env[Brand.env.maxOutputTokens] = "200000"
      // DeepSeek documents 384K for deepseek-flash; Z.ai and Anthropic 128K.
      expect(Brand.provider.request("rafiki-fast").output).toBe(200_000)
      expect(Brand.provider.request("rafiki-pro").output).toBe(32_000)
      expect(Brand.provider.request("rafiki-max").output).toBe(32_000)
      process.env[Brand.env.maxOutputTokens] = "128000"
      expect(Brand.provider.request("rafiki-max").output).toBe(128_000)
    } finally {
      if (saved === undefined) delete process.env[Brand.env.maxOutputTokens]
      else process.env[Brand.env.maxOutputTokens] = saved
    }
  })
})

describe("the model label", () => {
  test("the provider name is not repeated after a model name that starts with it", () => {
    expect(Brand.provider.label("Rafiki", "Rafiki Fast")).toBe("")
    expect(Brand.provider.label("Rafiki", "Rafiki")).toBe("")
    expect(Brand.provider.label("OpenAI", "GPT-5")).toBe("OpenAI")
    expect(Brand.provider.label("Rafiki", "Rafikifast")).toBe("Rafiki")
  })
})

describe("the identity given to the model", () => {
  test("names the product and its maker, forbids other products and makers, and names the tier honestly", () => {
    const text = Brand.identity(Brand.provider.id, "rafiki-fast")!
    expect(text).toContain("You are Rafiki Code, a coding agent for the terminal made by PANEOTECH.")
    expect(text).toContain("answer that you are Rafiki Code by PANEOTECH")
    expect(text).toContain("Never say that you are another product")
    expect(text).toContain("the Rafiki Fast tier (rafiki-fast)")
    expect(text).toContain("do not guess, claim or deny the name of the model")
    expect(Brand.identity(Brand.provider.id, "rafiki-max")).toContain("the Rafiki Max tier (rafiki-max)")
  })

  test("is given only to models of the gateway provider", () => {
    expect(Brand.identity("openai", "gpt-5")).toBeUndefined()
  })

  test("the upstream opening line names the product, not the binary", () => {
    expect(Brand.prompt("You are opencode, an interactive CLI tool")).toBe("You are Rafiki Code, an interactive CLI tool")
    expect(Brand.prompt("You are OpenCode, the best coding agent")).toBe("You are Rafiki Code, the best coding agent")
    expect(Brand.prompt("- /help: Get help with using opencode")).toBe("- /help: Get help with using rafikicode")
  })
})
