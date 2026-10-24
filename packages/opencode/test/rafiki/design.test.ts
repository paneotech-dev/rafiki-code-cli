// User interface work: detection, the design guide added once per session,
// the layout plan before building and when it is skipped (rafiki/design.ts,
// brand/design.ts), and the tier that looks at screenshots (routing.ts).
import { describe, expect, test } from "bun:test"
import { Design } from "@opencode-ai/core/brand/design"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as RafikiDesign from "../../src/rafiki/design"
import * as RafikiRouting from "../../src/rafiki/routing"

describe("detection", () => {
  test("interface requests", () => {
    for (const text of [
      "Build a landing page for a bakery",
      "Make the pricing page responsive",
      "restyle the login form with Tailwind",
      "the dashboard looks dated, redesign it",
      "add dark mode to the settings page",
    ])
      expect(Design.detect({ text })).toBe(true)
  })
  test("other work", () => {
    for (const text of [
      "fix the crash in the parser",
      "add a database migration for orders",
      "write unit tests for the API endpoint",
      "review the api design of the billing service",
      "rename the variable foo to bar",
    ])
      expect(Design.detect({ text })).toBe(false)
  })
  test("files lean a weak request towards the interface", () => {
    expect(Design.detect({ text: "tidy up the header" })).toBe(false)
    expect(Design.detect({ text: "tidy up the header", files: ["src/components/Header.tsx", "src/styles/header.css"] })).toBe(true)
  })
  test("asking to skip the plan", () => {
    for (const text of ["landing page, no plan", "skip the plan and build the page", "just build it", "build it directly"])
      expect(Design.skipPlan(text)).toBe(true)
    expect(Design.skipPlan("build a landing page")).toBe(false)
  })
})

let n = 0
function user(text: string, extra: Record<string, unknown>[] = []) {
  const id = `msg_${++n}`
  return {
    info: { id, sessionID: "ses_1", role: "user" },
    parts: [{ id: `prt_${n}`, messageID: id, sessionID: "ses_1", type: "text", text }, ...extra],
  } as any
}
function assistant(text: string) {
  const id = `msg_${++n}`
  return { info: { id, sessionID: "ses_1", role: "assistant" }, parts: [{ id: `prt_${n}`, type: "text", text }] } as any
}
const synthetic = (message: any) => message.parts.filter((part: any) => part.synthetic).map((part: any) => part.text as string)

describe("apply", () => {
  test("the guide and the plan go on the first interface request", () => {
    const messages = [user("hello, what does this repo do?"), assistant("A shop."), user("Build a landing page for the shop")]
    const applied = RafikiDesign.apply({ messages, agent: "build", subagent: false, attended: true })
    expect(applied).toEqual({ guide: true, plan: true })
    expect(synthetic(messages[0])).toEqual([])
    const added = synthetic(messages[2])
    expect(added[0]).toStartWith(Design.GUIDE_INTRO)
    expect(added[0]).toContain("## Typography")
    expect(added[0]).not.toContain("<!--")
    expect(added[1]).toBe(Design.PLAN_NOTE)
  })

  test("later turns keep it at the same place, once", () => {
    const first = user("Build a landing page for the shop")
    const messages = [first, assistant("Plan: hero, features, footer"), user("yes, build it")]
    RafikiDesign.apply({ messages, agent: "build", subagent: false, attended: true })
    expect(synthetic(first)).toHaveLength(2)
    expect(synthetic(messages[2])).toEqual([])
  })

  test("no interface work: nothing added", () => {
    const messages = [user("fix the failing unit tests in the parser")]
    expect(RafikiDesign.apply({ messages, agent: "build", subagent: false, attended: true })).toEqual({ guide: false, plan: false })
    expect(synthetic(messages[0])).toEqual([])
  })

  test("the plan is skipped when asked, in Plan mode, in a subagent, unattended or turned off", () => {
    const cases: [Parameters<typeof RafikiDesign.apply>[0], string][] = [
      [{ messages: [user("Build a landing page, no plan")], agent: "build", subagent: false, attended: true }, "asked"],
      [{ messages: [user("Build a landing page")], agent: "plan", subagent: false, attended: true }, "plan mode"],
      [{ messages: [user("Build a landing page")], agent: "build", subagent: true, attended: true }, "subagent"],
      [{ messages: [user("Build a landing page")], agent: "build", subagent: false, attended: false }, "run"],
      [{ messages: [user("Build a landing page")], agent: "build", subagent: false, attended: true, settings: { plan: false } }, "config"],
    ]
    for (const [input, why] of cases) {
      const applied = RafikiDesign.apply(input)
      expect({ why, ...applied }).toEqual({ why, guide: true, plan: false })
    }
  })

  test("the guide can be turned off", () => {
    const messages = [user("Build a landing page")]
    expect(RafikiDesign.apply({ messages, agent: "build", subagent: false, attended: true, settings: { guide: false } })).toEqual({
      guide: false,
      plan: true,
    })
    expect(synthetic(messages[0])).toEqual([Design.PLAN_NOTE])
  })

  test("nobody answers in run, serve, github and pr", () => {
    expect(RafikiDesign.attended(undefined)).toBe(true)
    expect(RafikiDesign.attended("acp")).toBe(true)
    expect(RafikiDesign.attended("web")).toBe(true)
    for (const command of ["run", "serve", "github", "pr"]) expect(RafikiDesign.attended(command)).toBe(false)
  })
})

describe("the tier that looks at screenshots", () => {
  const provider = Brand.provider.id
  test("follows the tiers that take images, never moves to rafiki-max", () => {
    const images = Brand.provider.images
    const expected = (Brand.models as readonly string[]).find((tier) => images.includes(tier) && tier !== "rafiki-max")
    for (const tier of ["rafiki-fast", "rafiki-pro"]) {
      const route = RafikiRouting.lookTier({ providerID: provider, tier, env: {} })
      if (images.includes(tier) || !expected) expect(route).toBeUndefined()
      else expect(route?.tier).toBe(expected)
    }
    expect(RafikiRouting.lookTier({ providerID: provider, tier: "rafiki-max", env: {} })).toBeUndefined()
  })
  test("other providers and routing off: no look", () => {
    expect(RafikiRouting.lookTier({ providerID: "openai", tier: "gpt-5", env: {} })).toBeUndefined()
    expect(RafikiRouting.lookTier({ providerID: provider, tier: "rafiki-pro", env: { [Brand.env.routing]: "off" } })).toBeUndefined()
  })
  test("measured 24 Oct 2026: rafiki-fast and rafiki-max take images on the gateway, rafiki-pro does not", () => {
    expect([...Brand.provider.images]).toEqual(["rafiki-fast", "rafiki-max"])
  })
  test("a rafiki-pro session's screenshots are looked at by rafiki-fast; rafiki-fast looks itself", () => {
    expect(RafikiRouting.lookTier({ providerID: provider, tier: "rafiki-pro", env: {} })).toEqual({
      tier: "rafiki-fast",
      reason: "look: rafiki-pro takes no images, rafiki-fast looks at the screenshots",
      escalated: false,
    })
    expect(RafikiRouting.lookTier({ providerID: provider, tier: "rafiki-fast", env: {} })).toBeUndefined()
  })
  test("the model table offers image input on rafiki-fast and rafiki-max only", () => {
    const models = (Brand.provider.config() as any)[provider].models as Record<string, any>
    expect(models["rafiki-fast"].attachment).toBe(true)
    expect(models["rafiki-fast"].modalities).toEqual({ input: ["text", "image"], output: ["text"] })
    expect(models["rafiki-max"].attachment).toBe(true)
    expect(models["rafiki-pro"].attachment).toBe(false)
    expect(models["rafiki-pro"].modalities).toBeUndefined()
  })
})
