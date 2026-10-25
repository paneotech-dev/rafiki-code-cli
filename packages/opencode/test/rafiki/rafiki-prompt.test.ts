// The system prompt of the Rafiki gateway tiers (src/session/prompt/rafiki.txt),
// chosen in session/system.ts for every model of the gateway provider.
import { describe, expect, test } from "bun:test"
import { SystemPrompt } from "../../src/session/system"
import type { Provider } from "../../src/provider/provider"

describe("rafiki prompt", () => {
  test("every model of the gateway provider gets the Rafiki prompt after the identity", () => {
    for (const id of ["rafiki-fast", "rafiki-pro", "rafiki-max", "deepseek-pro"]) {
      const parts = SystemPrompt.provider({ providerID: "rafiki", id, api: { id } } as Provider.Model)
      const prompt = parts.join("\n")
      expect(parts[0]).toContain("Rafiki Code")
      expect(prompt).toContain("# Requirements")
      expect(prompt).toContain("If the same approach fails twice for the same reason")
      expect(prompt).toContain("A check that also fails without your change is not yours to fix")
      expect(prompt).toContain("Run a check again only after you change the code it covers")
      expect(prompt).not.toContain("One word answers are best")
      expect(prompt).not.toContain("ask the user for the command")
    }
  })

  test("other providers keep the upstream default prompt", () => {
    const prompt = SystemPrompt.provider({ providerID: "openrouter", id: "x", api: { id: "some-model" } } as Provider.Model)[0]
    expect(prompt).toContain("One word answers are best")
    expect(prompt).not.toContain("# Requirements")
  })
})
