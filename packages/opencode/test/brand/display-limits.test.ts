// The tiers' windows are the real 1M, and since 2026-10-05 a session uses
// the whole window before it is compacted (owner's decision). Checked with the
// compaction check itself (session/overflow.ts).
import { afterEach, describe, expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand/brand"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { usable } from "../../src/session/overflow"
import type { Provider } from "@/provider/provider"

const names = [Brand.env.apiKey, Brand.env.maxOutputTokens]
const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))

afterEach(() => {
  for (const name of names) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

const cfg = {} as ConfigV1.Info

function registered(id: (typeof Brand.models)[number]) {
  process.env[Brand.env.apiKey] = "sk-test-not-a-real-key"
  const entry = Brand.provider.config().rafiki.models[id]
  return { providerID: Brand.provider.id, id, limit: entry.limit } as unknown as Provider.Model
}

describe("the tiers' windows and the compaction point", () => {
  test("each tier's window is the real one", () => {
    for (const id of Brand.models) expect(registered(id).limit.context).toBe(1_000_000)
  })

  test("a session is compacted near the end of the window: 936000 tokens on fast and pro, 968000 on max", () => {
    delete process.env[Brand.env.maxOutputTokens]
    expect(usable({ cfg, model: registered("rafiki-fast") })).toBe(936_000)
    expect(usable({ cfg, model: registered("rafiki-pro") })).toBe(936_000)
    expect(usable({ cfg, model: registered("rafiki-max") })).toBe(968_000)
  })

  test("an output override leaves room for that output in the window", () => {
    process.env[Brand.env.maxOutputTokens] = "16000"
    expect(usable({ cfg, model: registered("rafiki-fast") })).toBe(984_000)
    process.env[Brand.env.maxOutputTokens] = "128000"
    expect(usable({ cfg, model: registered("rafiki-pro") })).toBe(872_000)
  })
})
