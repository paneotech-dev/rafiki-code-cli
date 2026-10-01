/// <reference path="../markdown.d.ts" />
import { Brand } from "../brand/brand"

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import { BrandSkill } from "../brand/skill"
import customizeOpencodeContent from "./skill/customize-opencode.md" with { type: "text" }

export const CustomizeOpencodeContent = customizeOpencodeContent

// The built-in configuration skill. The upstream body is kept for a build that
// offers the upstream skill (Brand.hiddenSkills empty); this product registers
// its own instead, because the mitigation matters and the upstream body teaches
// file names and a schema URL that are wrong here (brand/skill.ts).
export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      const hidden = Brand.hiddenSkills.includes("customize-opencode")
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: hidden ? BrandSkill.name : "customize-opencode",
            description: hidden
              ? BrandSkill.description
              : `Use ONLY when the user is editing or creating ${Brand.name}'s own configuration: ${Brand.project.file}.json, ${Brand.project.file}.jsonc, files under ${Brand.project.dir}/, or files under ~/${Brand.configDirName}/. Also use when creating or fixing ${Brand.name} agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring ${Brand.name} itself.`,
            location: AbsolutePath.make(hidden ? BrandSkill.location : "/builtin/customize-opencode.md"),
            content: hidden ? BrandSkill.body() : CustomizeOpencodeContent,
          }),
        }),
      )
    })
  }),
})
