// The tiers' windows moved from 128000 to the real 1M, for the "% used"
// figure only: a session is compacted at the point it was before, whatever
// the output limit, because moving that point changes what a long session
// costs. Checked with the compaction check itself (session/overflow.ts).
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
  const entry = Brand.provider.config()[Brand.provider.id].models[id]
  return { providerID: Brand.provider.id, id, limit: entry.limit } as unknown as Provider.Model
}

// The tier as it was registered until 2026-10-04: a 128000 window, no input limit.
function before(id: (typeof Brand.models)[number]) {
  const now = registered(id)
  return { ...now, limit: { context: 128_000, output: now.limit.output } } as Provider.Model
}

describe("the tiers' windows and the compaction point", () => {
  test("each tier's window is the real one", () => {
    for (const id of Brand.models) expect(registered(id).limit.context).toBe(1_000_000)
  })

  test("a session is compacted where it was: 64000 tokens on fast, 96000 on pro and max", () => {
    delete process.env[Brand.env.maxOutputTokens]
    expect(usable({ cfg, model: registered("rafiki-fast") })).toBe(64_000)
    expect(usable({ cfg, model: registered("rafiki-pro") })).toBe(96_000)
    expect(usable({ cfg, model: registered("rafiki-max") })).toBe(96_000)
    for (const id of Brand.models) expect(usable({ cfg, model: registered(id) })).toBe(usable({ cfg, model: before(id) }))
  })

  test("with an output override the point is the same as before, never below 64000", () => {
    process.env[Brand.env.maxOutputTokens] = "16000"
    expect(usable({ cfg, model: registered("rafiki-fast") })).toBe(usable({ cfg, model: before("rafiki-fast") }))
    expect(usable({ cfg, model: registered("rafiki-fast") })).toBe(112_000)
    process.env[Brand.env.maxOutputTokens] = "128000"
    // Before: 128000 - 128000, a compaction after every answer.
    expect(usable({ cfg, model: before("rafiki-pro") })).toBe(0)
    expect(usable({ cfg, model: registered("rafiki-pro") })).toBe(64_000)
    process.env[Brand.env.maxOutputTokens] = "300000"
    expect(usable({ cfg, model: registered("rafiki-fast") })).toBe(64_000)
  })
})
