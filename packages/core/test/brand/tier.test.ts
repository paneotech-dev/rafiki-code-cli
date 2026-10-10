// Choosing a tier: the price in credits shown beside each tier, the one
// confirmation before Rafiki Max, and the key check from /key/info.
import { describe, expect, test } from "bun:test"
import * as Account from "../../src/brand/account"
import * as Tier from "../../src/brand/tier"

describe("credits", () => {
  test("each tier states its rate, as the approval page does", () => {
    expect(Tier.credits("rafiki-fast")).toBe("1x credits")
    expect(Tier.credits("rafiki-pro")).toBe("4x credits")
    expect(Tier.credits("rafiki-max")).toBe("15x credits")
    expect(Tier.credits("other")).toBeUndefined()
  })

  test("only rafiki-max asks for a confirmation", () => {
    expect(Tier.needsConfirm("rafiki", "rafiki-max")).toBe(true)
    expect(Tier.needsConfirm("rafiki", "rafiki-fast")).toBe(false)
    expect(Tier.needsConfirm("rafiki", "rafiki-pro")).toBe(false)
    expect(Tier.needsConfirm("other", "rafiki-max")).toBe(false)
    expect(Tier.confirmMessage()).toContain("15x credits")
  })
})

describe("the key's models", () => {
  test("a list without the tier refuses it", () => {
    expect(Tier.allows(["rafiki-fast", "rafiki-pro"], "rafiki-max")).toBe(false)
    expect(Tier.allows(["rafiki-fast", "rafiki-max"], "rafiki-max")).toBe(true)
  })

  test("an empty list or an every-model marker says nothing", () => {
    expect(Tier.allows([], "rafiki-max")).toBeUndefined()
    expect(Tier.allows(undefined, "rafiki-max")).toBeUndefined()
    expect(Tier.allows(["all-proxy-models"], "rafiki-max")).toBeUndefined()
  })

  test("the message says the key lacks the tier and how to fix it", () => {
    const text = Tier.notOnKeyMessage("rafiki-max")
    expect(text).toContain("approved without the Rafiki Max tier")
    expect(text).toContain("rafikicode login again and tick Max")
  })
})

describe("/key/info", () => {
  test("spend, budget and models are read from either shape", () => {
    expect(Account.parseKeyInfo({ key: "x", info: { spend: 1.25, max_budget: 10, models: ["rafiki-fast"] } })).toEqual({
      spend: 1.25,
      maxBudget: 10,
      models: ["rafiki-fast"],
    })
    expect(Account.parseKeyInfo({ spend: 0, max_budget: null })).toEqual({ spend: 0, maxBudget: null, models: [] })
    expect(Account.parseKeyInfo({ info: { spend: "a lot" } })).toBeUndefined()
    expect(Account.parseKeyInfo(undefined)).toBeUndefined()
  })

  test("the gateway's refusal and a network failure are told apart", async () => {
    const source = { key: "sk-test", gatewayURL: "https://gateway.example/v1" }
    const seen: string[] = []
    const refused = await Account.keyInfo({
      source,
      fetch: async (url) => {
        seen.push(url)
        return new Response("{}", { status: 401 })
      },
    })
    expect(seen).toEqual(["https://gateway.example/key/info"])
    expect(refused).toMatchObject({ ok: false, status: 401 })
    const down = await Account.keyInfo({
      source,
      fetch: async () => {
        throw new Error("offline")
      },
    })
    expect(down.ok).toBe(false)
    expect((down as { status?: number }).status).toBeUndefined()
    const fine = await Account.keyInfo({
      source,
      fetch: async () => Response.json({ info: { spend: 2, max_budget: 5, models: ["rafiki-max"] } }),
    })
    expect(fine).toMatchObject({ ok: true, info: { spend: 2, maxBudget: 5, models: ["rafiki-max"] } })
  })
})
