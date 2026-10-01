import { describe, expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand/brand"
import { AccountTransportError } from "../../src/account/schema"
import { configFix, FormatError } from "../../src/cli/error"
import { UI } from "../../src/cli/ui"

describe("cli.error", () => {
  test("formats legacy and tagged config errors the same way", () => {
    const cases = [
      {
        tag: "ConfigJsonError",
        data: { path: "/tmp/opencode.jsonc", message: "Unexpected token" },
        expected: "Config file at /tmp/opencode.jsonc is not valid JSON(C): Unexpected token\n" + configFix(),
      },
      {
        tag: "ConfigDirectoryTypoError",
        data: { path: "/tmp/opencode.jsonc", dir: ".opencode", suggestion: "opencode" },
        expected:
          'Directory ".opencode" in /tmp/opencode.jsonc is not valid. Rename the directory to "opencode" or remove it. This is a common typo.',
      },
      {
        tag: "ConfigFrontmatterError",
        data: { path: "/tmp/AGENTS.md", message: "failed frontmatter" },
        expected: "failed frontmatter",
      },
      {
        tag: "ConfigInvalidError",
        data: {
          path: "/tmp/opencode.jsonc",
          message: "schema mismatch",
          issues: [{ message: "Expected string", path: ["provider", "id"] }],
        },
        expected:
          "Configuration is invalid at /tmp/opencode.jsonc: schema mismatch\n↳ Expected string provider.id\n" +
          configFix(),
      },
    ]

    for (const item of cases) {
      expect(FormatError({ name: item.tag, data: item.data })).toBe(item.expected)
      expect(FormatError({ _tag: item.tag, ...item.data })).toBe(item.expected)
    }
  })

  test("preserves multiline JSONC diagnostics for tagged config errors", () => {
    const data = {
      path: "/tmp/opencode.jsonc",
      message:
        '\n--- JSONC Input ---\n{\n  "model": \n}\n--- Errors ---\nValueExpected at line 3, column 1\n   Line 3: }\n          ^\n--- End ---',
    }
    const expected = `Config file at ${data.path} is not valid JSON(C): ${data.message}\n${configFix()}`

    expect(FormatError({ name: "ConfigJsonError", data })).toBe(expected)
    expect(FormatError({ _tag: "ConfigJsonError", ...data })).toBe(expected)
  })

  test("formats account transport errors clearly", () => {
    const error = new AccountTransportError({
      method: "POST",
      url: "https://console.opencode.ai/auth/device/code",
    })

    const formatted = FormatError(error)

    expect(formatted).toContain("Could not reach POST https://console.opencode.ai/auth/device/code.")
    expect(formatted).toContain("This failed before the server returned an HTTP response.")
    expect(formatted).toContain("Check your network, proxy, or VPN configuration and try again.")
  })

  test("formats legacy and tagged provider model errors the same way", () => {
    const data = {
      providerID: "anthropic",
      modelID: "claude-sonet-4",
      suggestions: ["claude-sonnet-4"],
    }
    const expected = [
      "Model not found: anthropic/claude-sonet-4",
      "Did you mean: claude-sonnet-4",
      "Try: `rafikicode models` to list available models",
      "Or check your config (~/.rafikicode/config.json) provider/model names",
    ].join("\n")

    expect(FormatError({ name: "ProviderModelNotFoundError", data })).toBe(expected)
    expect(FormatError({ _tag: "ProviderModelNotFoundError", ...data })).toBe(expected)
  })

  test("formats legacy and tagged provider init errors the same way", () => {
    const data = { providerID: "anthropic" }
    const expected = 'Failed to initialize provider "anthropic". Check credentials and configuration.'

    expect(FormatError({ name: "ProviderInitError", data })).toBe(expected)
    expect(FormatError({ _tag: "ProviderInitError", ...data })).toBe(expected)
  })

  test("formats cancelled UI errors as empty output", () => {
    expect(FormatError(new UI.CancelledError())).toBe("")
  })

  // A config file that fails at session start used to print the raw schema issue
  // and stop there, which is the one moment the person cannot look anything up:
  // the tool they would ask is the tool that just refused to start. doctor's
  // message for the same failure has always been good; this is the same help.
  describe("a broken config file says what to do about it", () => {
    const fix = configFix()

    test("the fix names doctor, the switch that skips the working tree, and the schema", () => {
      expect(fix).toContain(`${Brand.name} doctor`)
      expect(fix).toContain(`${Brand.env.disableProjectConfig}=1`)
      expect(fix).toContain(Brand.schema.config)
      expect(fix.split("\n")).toHaveLength(3)
    })

    test("an invalid config keeps its issues and gains the fix", () => {
      const formatted = FormatError({
        name: "ConfigInvalidError",
        data: { path: "/repo/rafikicode.json", issues: [{ message: "Expected array", path: ["instructions"] }] },
      })!
      expect(formatted).toContain("Configuration is invalid at /repo/rafikicode.json")
      expect(formatted).toContain("Expected array instructions")
      expect(formatted.endsWith(fix)).toBe(true)
    })

    test("a config that is not valid JSON gains the same fix", () => {
      const formatted = FormatError({ name: "ConfigJsonError", data: { path: "/repo/rafikicode.json" } })!
      expect(formatted.endsWith(fix)).toBe(true)
    })

    test("the fix never names the upstream project", () => {
      expect(fix).not.toMatch(/(?<![A-Z_])opencode(?![A-Z_])/i)
    })
  })
})
