// The tiers' windows are the real 1M (what "% used" is measured against), and
// since 2026-10-13 a session is compacted at 150000 tokens of context on every
// tier (owner's decision), unless compaction.threshold or RAFIKICODE_COMPACT_AT
// moves the point. Checked with the compaction check itself (session/overflow.ts).
import { afterEach, describe, expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand/brand"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { usable } from "../../src/session/overflow"
import type { Provider } from "@/provider/provider"

const names = [Brand.env.apiKey, Brand.env.maxOutputTokens, Brand.env.compactAt]
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

  test("a session is compacted at 150000 tokens on every tier", () => {
    delete process.env[Brand.env.maxOutputTokens]
    delete process.env[Brand.env.compactAt]
    expect(Brand.context.compactAt).toBe(150_000)
    for (const id of Brand.models) expect(usable({ cfg, model: registered(id) })).toBe(150_000)
  })

  test("the compaction point is not an input limit: the window stays 1M for the display", () => {
    for (const id of Brand.models) {
      expect(registered(id).limit.input).toBeUndefined()
      expect(registered(id).limit.context).toBe(1_000_000)
    }
  })

  test("compaction.threshold moves the point, and RAFIKICODE_COMPACT_AT wins over it", () => {
    delete process.env[Brand.env.compactAt]
    delete process.env[Brand.env.maxOutputTokens]
    const configured = { compaction: { threshold: 300_000 } } as ConfigV1.Info
    expect(usable({ cfg: configured, model: registered("rafiki-pro") })).toBe(300_000)
    process.env[Brand.env.compactAt] = "80000"
    expect(usable({ cfg: configured, model: registered("rafiki-pro") })).toBe(80_000)
    process.env[Brand.env.compactAt] = "120,000"
    expect(usable({ cfg, model: registered("rafiki-fast") })).toBe(120_000)
  })

  test("off leaves only the window less the output a request may ask for", () => {
    process.env[Brand.env.compactAt] = "off"
    delete process.env[Brand.env.maxOutputTokens]
    expect(usable({ cfg, model: registered("rafiki-fast") })).toBe(936_000)
    expect(usable({ cfg, model: registered("rafiki-pro") })).toBe(936_000)
    expect(usable({ cfg, model: registered("rafiki-max") })).toBe(968_000)
    process.env[Brand.env.maxOutputTokens] = "128000"
    expect(usable({ cfg, model: registered("rafiki-pro") })).toBe(872_000)
  })

  test("the output reserve still wins when the point is set above it", () => {
    process.env[Brand.env.compactAt] = "990000"
    process.env[Brand.env.maxOutputTokens] = "16000"
    expect(usable({ cfg, model: registered("rafiki-fast") })).toBe(984_000)
    process.env[Brand.env.maxOutputTokens] = "128000"
    expect(usable({ cfg, model: registered("rafiki-pro") })).toBe(872_000)
  })
})
