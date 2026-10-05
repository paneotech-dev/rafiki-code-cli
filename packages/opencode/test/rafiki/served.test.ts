// The tier that answered and the cache writes the gateway reports
// (src/rafiki/served.ts), through the client library adapter
// (session/llm/ai-sdk.ts) and the token split (Session.getUsage), the path a
// gateway answer takes to the figures the interface shows.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as ContextUsage from "@opencode-ai/core/brand/context"
import { Usage } from "@opencode-ai/llm"
import * as RafikiServed from "@/rafiki/served"
import { LLMAISDK } from "@/session/llm/ai-sdk"
import { Session } from "@/session/session"
import type { Provider } from "@/provider/provider"

type AdapterEvent = Parameters<typeof LLMAISDK.toLLMEvents>[1]

const rafiki = Brand.provider.id

describe("the tier that answered", () => {
  test("the tier asked for when it answered itself", () => {
    const metadata = RafikiServed.metadata({ modelId: "rafiki-fast" })
    expect(RafikiServed.model({ providerID: rafiki, requested: "rafiki-fast", metadata })).toBe("rafiki-fast")
  })

  test("the next tier when the gateway moved the request (streamed chunks name the tier that answered)", () => {
    const metadata = RafikiServed.metadata({ modelId: "rafiki-pro" })
    expect(RafikiServed.model({ providerID: rafiki, requested: "rafiki-fast", metadata })).toBe("rafiki-pro")
  })

  test("X-Rafiki-Model wins over the body when the gateway's edge sends it", () => {
    const metadata = RafikiServed.metadata({ modelId: "rafiki-fast", headers: { "X-Rafiki-Model": "rafiki-max" } })
    expect(RafikiServed.model({ providerID: rafiki, requested: "rafiki-fast", metadata })).toBe("rafiki-max")
  })

  test("a provider's own model name says nothing about the tier: the tier asked for is kept", () => {
    expect(RafikiServed.metadata({ modelId: "glm-5.3" })).toBeUndefined()
    expect(RafikiServed.model({ providerID: rafiki, requested: "rafiki-fast", metadata: { response: { modelId: "glm-5.3" } } })).toBe(
      "rafiki-fast",
    )
  })

  test("other providers are not concerned", () => {
    const metadata = { response: { modelId: "rafiki-pro" } }
    expect(RafikiServed.model({ providerID: "openai", requested: "gpt-5", metadata })).toBe("gpt-5")
    expect(RafikiServed.metadata({ modelId: "gpt-5" })).toBeUndefined()
  })

  test("run announces the tier that answered, and the plain header once the tier asked for answers again", () => {
    expect(RafikiServed.runLine("build", "rafiki-fast", "rafiki-pro")).toBe(
      "> build · rafiki-pro (rafiki-fast was asked for, the gateway answered on rafiki-pro)",
    )
    expect(RafikiServed.runLine("build", "rafiki-fast", "rafiki-fast")).toBe("> build · rafiki-fast")
  })
})

describe("cache writes in the gateway's usage block", () => {
  test("read from cache_creation_input_tokens when they fit inside prompt_tokens", () => {
    expect(
      RafikiServed.cacheWrite({
        prompt_tokens: 61_234,
        cache_creation_input_tokens: 8_000,
        prompt_tokens_details: { cached_tokens: 50_000 },
      }),
    ).toBe(8_000)
    expect(
      RafikiServed.cacheWrite({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 10, cache_creation_tokens: 40 } }),
    ).toBe(40)
  })

  test("not taken when they would not fit (a provider that reports them outside the input), or when absent", () => {
    expect(
      RafikiServed.cacheWrite({ prompt_tokens: 100, cache_creation_input_tokens: 90, prompt_tokens_details: { cached_tokens: 20 } }),
    ).toBeUndefined()
    expect(RafikiServed.cacheWrite({ prompt_tokens: 100 })).toBeUndefined()
    expect(RafikiServed.cacheWrite(undefined)).toBeUndefined()
  })
})

const adapt = (events: ReadonlyArray<AdapterEvent>) => {
  const state = LLMAISDK.adapterState()
  return Effect.runPromise(
    Effect.forEach(events, (event) => LLMAISDK.toLLMEvents(state, event)).pipe(Effect.map((items) => items.flat())),
  )
}

// What the client library makes of a gateway usage block (openai-compatible
// provider): prompt_tokens as inputTokens, cached_tokens as cache reads, no
// cache writes, the raw block kept.
function step(model: string, raw: Record<string, any>) {
  const cached = raw.prompt_tokens_details?.cached_tokens ?? 0
  const reasoning = raw.completion_tokens_details?.reasoning_tokens ?? 0
  return {
    type: "finish-step",
    response: { id: "chatcmpl-1", timestamp: new Date(0), modelId: model },
    finishReason: "stop",
    rawFinishReason: "stop",
    usage: {
      inputTokens: raw.prompt_tokens,
      inputTokenDetails: { noCacheTokens: raw.prompt_tokens - cached, cacheReadTokens: cached, cacheWriteTokens: undefined },
      outputTokens: raw.completion_tokens,
      outputTokenDetails: { textTokens: raw.completion_tokens - reasoning, reasoningTokens: reasoning },
      totalTokens: raw.prompt_tokens + raw.completion_tokens,
      reasoningTokens: reasoning,
      cachedInputTokens: cached,
      raw,
    },
    providerMetadata: undefined,
  } as unknown as AdapterEvent
}

const model = { providerID: rafiki, limit: { context: 1_000_000, output: 64_000 }, cost: { input: 0, output: 0 } } as unknown as Provider.Model

async function recorded(requested: string, served: string, raw: Record<string, any>) {
  const events = await adapt([step(served, raw)])
  const finish = events.find((event) => event.type === "step-finish") as { usage?: Usage; providerMetadata?: any }
  const usage = Session.getUsage({ model, usage: finish.usage ?? new Usage({}), metadata: finish.providerMetadata })
  return {
    tokens: usage.tokens,
    modelID: RafikiServed.model({ providerID: rafiki, requested, metadata: finish.providerMetadata }),
  }
}

describe("from a gateway answer to the recorded figures", () => {
  test("rafiki-fast: cached tokens counted once, shown apart", async () => {
    const result = await recorded("rafiki-fast", "rafiki-fast", {
      prompt_tokens: 24_530,
      completion_tokens: 412,
      total_tokens: 24_942,
      prompt_tokens_details: { cached_tokens: 20_480 },
      completion_tokens_details: { reasoning_tokens: 180 },
    })
    expect(result.modelID).toBe("rafiki-fast")
    expect(result.tokens).toMatchObject({ input: 4_050, output: 232, reasoning: 180, cache: { read: 20_480, write: 0 } })
    expect(ContextUsage.usage(result.tokens, 1_000_000)).toEqual({ tokens: 24_942, cached: 20_480, window: 1_000_000, percent: "2%" })
  })

  test("rafiki-max: cache writes leave plain input once and are recorded as writes", async () => {
    const result = await recorded("rafiki-max", "rafiki-max", {
      prompt_tokens: 61_234,
      completion_tokens: 900,
      total_tokens: 62_134,
      prompt_tokens_details: { cached_tokens: 50_000 },
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 8_000,
    })
    expect(result.tokens).toMatchObject({ input: 3_234, output: 900, cache: { read: 50_000, write: 8_000 } })
    expect(ContextUsage.usage(result.tokens, 1_000_000).tokens).toBe(62_134)
  })

  test("a fallback from fast to pro is recorded on pro", async () => {
    const result = await recorded("rafiki-fast", "rafiki-pro", {
      prompt_tokens: 45_000,
      completion_tokens: 700,
      prompt_tokens_details: { cached_tokens: 40_000 },
      completion_tokens_details: { reasoning_tokens: 200 },
    })
    expect(result.modelID).toBe("rafiki-pro")
  })
})
