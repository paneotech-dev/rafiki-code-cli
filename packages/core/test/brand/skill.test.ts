// The built-in configuration skill.
//
// The upstream project ships one because the model's guess at the shape of a
// config file is often wrong and the tool hard-fails on invalid config. This
// fork hid that skill, because its body teaches upstream file names and a schema
// URL that do not exist here, and for a while shipped nothing in its place: the
// hard-fail without the mitigation. This is the replacement, so the test that
// matters is that every fact in it is this product's.
import { describe, expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand/brand"
import { BrandSkill } from "@opencode-ai/core/brand/skill"

const upstreamWord = /(?<![A-Z_])opencode(?![A-Z_])/i

describe("BrandSkill", () => {
  const body = BrandSkill.body()

  test("it is named and located after this product, not the upstream one", () => {
    expect(BrandSkill.name).toBe(`customize-${Brand.name}`)
    expect(Brand.hiddenSkills).toContain("customize-opencode")
    expect(Brand.hiddenSkills).not.toContain(BrandSkill.name)
    expect(BrandSkill.location).toContain(BrandSkill.name)
  })

  test("the description gates on this product's own config files only", () => {
    expect(BrandSkill.description).toStartWith("Use ONLY when")
    expect(BrandSkill.description).toContain(`${Brand.project.file}.json`)
    expect(BrandSkill.description).toContain(`${Brand.project.dir}/`)
    expect(BrandSkill.description).toContain("Do not use for the user's own application code")
    expect(BrandSkill.description).not.toMatch(upstreamWord)
  })

  test("every placeholder is replaced", () => {
    expect(body).not.toMatch(/\{\{/)
  })

  test("it teaches this product's schema URL and file names", () => {
    expect(body).toContain(Brand.schema.config)
    expect(body).toContain(`${Brand.project.file}.json`)
    expect(body).toContain(Brand.configHint)
    expect(body).toContain(Brand.project.dir)
    expect(body).toContain(Brand.defaultModel)
  })

  test("it names only the tiers people are offered", () => {
    for (const model of Brand.provider.offered()) expect(body).toContain(`${Brand.provider.id}/${model}`)
    for (const model of Brand.provider.unlisted) expect(body).not.toContain(`${Brand.provider.id}/${model}`)
  })

  // The rule that most often makes a correct-looking project config do nothing,
  // and the one thing the upstream skill could never have known about.
  test("it teaches workspace trust", () => {
    expect(body).toContain("## Workspace trust")
    expect(body).toContain(`${Brand.name} trust`)
    expect(body).toContain(`${Brand.env.trustWorkspace}=1`)
    expect(body).toContain("project plugins and custom tools")
  })

  test("the escape hatch it names is this product's, and doctor is how to find the file", () => {
    expect(body).toContain(`${Brand.env.disableProjectConfig}=1`)
    expect(body).toContain(`${Brand.name} doctor`)
  })

  test("nothing in the body names the upstream project, bar the plugin package", () => {
    // @opencode-ai/plugin is the real package a plugin imports its types from;
    // a plugin that named anything else would not typecheck.
    const text = body.split("@opencode-ai/plugin").join("<plugin-package>")
    const leaks = text.match(/.{0,60}opencode.{0,60}/gi)
    expect(leaks ?? []).toEqual([])
    expect(text).not.toMatch(upstreamWord)
  })

  test("it teaches the traps the decoder actually refuses", () => {
    // Checked against the decoder in packages/opencode/test/rafiki/doctor-followups.
    expect(body).toContain("`permissions` is refused")
    expect(body).toContain("array of strings, never one string")
    expect(body).toContain("Unknown top-level keys are ignored")
  })

  test("it tells the model a restart is needed", () => {
    expect(body).toContain(`quit and restart ${Brand.name}`)
  })
})
