// Schema URLs written as $schema into config files: pinned to the release tag
// of the running binary, a published fallback tag for every other build, and a
// narrow repair for the broken main branch URL shipped in v0.1.0 and v0.1.1.
import { describe, expect, test } from "bun:test"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"

const base = "https://raw.githubusercontent.com/paneotech-dev/rafiki-code-cli"
const repo = path.resolve(import.meta.dir, "../../../..")
const fallback = (kind: string) => `${base}/${Brand.schema.fallbackTag}/schema/${kind}.json`

describe("schema URL", () => {
  test("a release build points at its own version tag", () => {
    expect(Brand.schema.url("config", "0.1.1", "latest")).toBe(`${base}/v0.1.1/schema/config.json`)
    expect(Brand.schema.url("tui", "0.1.1", "latest")).toBe(`${base}/v0.1.1/schema/tui.json`)
    expect(Brand.schema.url("config", "1.20.3", "latest")).toBe(`${base}/v1.20.3/schema/config.json`)
    expect(Brand.schema.url("config", "0.2.0-rc.1", "latest")).toBe(`${base}/v0.2.0-rc.1/schema/config.json`)
  })

  test("every other build points at the fallback tag", () => {
    const builds: [string, string][] = [
      ["local", "local"],
      ["0.1.2", "local"],
      ["0.1.2", "beta"],
      ["0.0.0-main-202609151200", "main"],
      ["0.0.0-main-202609151200", "latest"],
      ["v0.1.1", "latest"],
      ["0.1", "latest"],
      ["0.1.1/../../main", "latest"],
      ["", "latest"],
    ]
    for (const [version, channel] of builds) {
      expect(Brand.schema.url("config", version, channel)).toBe(fallback("config"))
      expect(Brand.schema.url("tui", version, channel)).toBe(fallback("tui"))
    }
  })

  test("the running build never writes the main branch URL", () => {
    for (const url of [Brand.schema.config, Brand.schema.tui]) {
      expect(url.startsWith(`${base}/v`)).toBe(true)
      expect(url).not.toContain("/main/")
    }
    expect(Brand.schema.broken.config).toBe(`${base}/main/schema/config.json`)
    expect(Brand.schema.broken.tui).toBe(`${base}/main/schema/tui.json`)
  })

  // The published v0.1.1 tag points at this commit. It is checked by commit and
  // not by tag name: a clone that also fetched upstream tags holds an unrelated
  // v0.1.1. Skipped in shallow clones that lack the commit.
  const fallbackCommit = "bcc2511c313088bc5374c4c92f44afc43c955b40"
  const present = Bun.spawnSync(["git", "cat-file", "-e", `${fallbackCommit}^{commit}`], { cwd: repo }).success
  test.skipIf(!present)("the fallback tag commit carries both schema files", () => {
    expect(Brand.schema.fallbackTag).toBe("v0.1.1")
    for (const file of ["schema/config.json", "schema/tui.json"]) {
      const proc = Bun.spawnSync(["git", "cat-file", "-e", `${fallbackCommit}:${file}`], { cwd: repo })
      expect(proc.success).toBe(true)
    }
  })
})

describe("schema repair", () => {
  const url = `${base}/v9.9.9/schema/config.json`
  const broken = Brand.schema.broken.config

  test("replaces only the broken $schema value and keeps every other byte", () => {
    const text = `{\n  // editor settings\n  "$schema" :  "${broken}",\n  "username": "a",\n}\n`
    expect(Brand.schema.repair(text, broken, "config", url)).toBe(
      `{\n  // editor settings\n  "$schema" :  "${url}",\n  "username": "a",\n}\n`,
    )
  })

  test("repairs the tui URL when asked for tui", () => {
    const tui = `${base}/v9.9.9/schema/tui.json`
    const text = JSON.stringify({ $schema: Brand.schema.broken.tui, theme: "x" }, null, 2)
    expect(Brand.schema.repair(text, Brand.schema.broken.tui, "tui", tui)).toBe(
      JSON.stringify({ $schema: tui, theme: "x" }, null, 2),
    )
    expect(Brand.schema.repair(text, Brand.schema.broken.tui, "config", url)).toBeUndefined()
  })

  test("leaves anything else alone", () => {
    const cases: [string, unknown][] = [
      [JSON.stringify({ username: "a" }), undefined],
      [JSON.stringify({ $schema: url }), url],
      [JSON.stringify({ $schema: fallback("config") }), fallback("config")],
      [JSON.stringify({ $schema: `${broken}#x` }), `${broken}#x`],
      [JSON.stringify({ $schema: "https://opencode.ai/config.json" }), "https://opencode.ai/config.json"],
      // The broken URL under another key is not a schema line.
      [JSON.stringify({ $schema: url, note: broken }), url],
      // Parsed value says broken but the text does not hold it once as $schema.
      [JSON.stringify({ note: broken }), broken],
      [`{"$schema": "${broken}", "$schema": "${broken}"}`, broken],
    ]
    for (const [text, value] of cases) expect(Brand.schema.repair(text, value, "config", url)).toBeUndefined()
  })
})
