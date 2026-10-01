import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { BrandSkill } from "@opencode-ai/core/brand/skill"
import { SkillPlugin } from "@opencode-ai/core/plugin/skill"
import { SkillV2 } from "@opencode-ai/core/skill"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(SkillV2.node))

const registered = Effect.gen(function* () {
  const skill = yield* SkillV2.Service
  yield* SkillPlugin.Plugin.effect(host({ skill: { ...skill, reload: skill.reload } }))
  return yield* skill.list()
})

describe("SkillPlugin.Plugin", () => {
  // rafikicode hides this upstream skill (Brand.hiddenSkills): its body names upstream config files.
  it.effect("does not register the built-in customize-opencode skill", () =>
    Effect.gen(function* () {
      expect((yield* registered).map((item) => item.name)).not.toContain("customize-opencode")
    }),
  )

  // Hiding it dropped the mitigation for a hard failure, so a replacement ships
  // in its place: the same job, with this product's paths and schema URL.
  it.effect("registers the configuration skill written for this product instead", () =>
    Effect.gen(function* () {
      const skills = yield* registered
      const found = skills.find((item) => item.name === BrandSkill.name)
      expect(found).toBeDefined()
      expect(found!.description).toBe(BrandSkill.description)
      expect(found!.content).toBe(BrandSkill.body())
    }),
  )
})
