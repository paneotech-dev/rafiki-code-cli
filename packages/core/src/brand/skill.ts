/// <reference path="../markdown.d.ts" />
export * as BrandSkill from "./skill"

// The built-in configuration skill.
//
// The upstream project ships one because the model's intuition for what its
// config file looks like is often wrong, and the tool hard-fails on an invalid
// config: a guess costs the user a refused startup. rafikicode hides that skill
// (Brand.hiddenSkills) because its body teaches upstream file names and a schema
// URL that do not exist here. Hiding it without replacing it kept the hard-fail
// and dropped the mitigation, so this is the replacement: the same job, written
// for this product, with the brand values substituted in at load so the brand
// layer stays the one source of truth.
import path from "path"
import { Brand } from "./brand"
import content from "./skill/customize.md" with { type: "text" }

export const name = `customize-${Brand.name}`

// The global config directory, as the hint spells it: ~/.rafikicode.
const configDir = path.dirname(Brand.configHint)

// Narrow on purpose. The skill is about this product's own configuration, and a
// skill that fires while the model edits the user's application code is worse
// than no skill at all.
export const description = `Use ONLY when the user is editing or creating ${Brand.name}'s own configuration: ${Brand.project.file}.json, ${Brand.project.file}.jsonc, files under ${Brand.project.dir}/, or files under ${configDir}/. Also use when creating or fixing ${Brand.name} agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring ${Brand.name} itself.`

// Where the skill reports itself as coming from.
export const location = `/builtin/${name}.md`

// Only the tiers people are offered (Brand.provider.unlisted); a tier that is
// not on the list must not be suggested to anyone.
const tiers = () =>
  Brand.provider
    .offered()
    .map((model) => `- \`${Brand.provider.id}/${model}\``)
    .join("\n")

const values = (): Record<string, string> => ({
  NAME: Brand.name,
  PRODUCT: Brand.product,
  SCHEMA: Brand.schema.config,
  PROJECT_FILE: `${Brand.project.file}.json`,
  PROJECT_FILE_C: `${Brand.project.file}.jsonc`,
  PROJECT_DIR: Brand.project.dir,
  CONFIG_DIR: configDir,
  CONFIG_HINT: Brand.configHint,
  PROVIDER: Brand.provider.id,
  DEFAULT_MODEL: Brand.defaultModel,
  MODEL_LIST: tiers(),
  ENV_TRUST: Brand.env.trustWorkspace,
  ENV_DISABLE_PROJECT: Brand.env.disableProjectConfig,
})

let rendered: string | undefined

// The body with every placeholder replaced, and the note to whoever edits the
// file stripped: it is for us, not for the model. Throws on a placeholder left
// over, because one the model reads verbatim is worse than a build failure.
// Rendered once: every instance of a run asks for the same text.
export function body() {
  if (rendered !== undefined) return rendered
  const source = (content as string).replace(/^\s*<!--[\s\S]*?-->\s*/, "")
  const replaced = Object.entries(values()).reduce((text, [key, value]) => text.split(`{{${key}}}`).join(value), source)
  const leftover = replaced.match(/\{\{[A-Za-z_]+\}\}/g)
  if (leftover) throw new Error(`${name}: unreplaced placeholders ${[...new Set(leftover)].join(", ")}`)
  rendered = replaced
  return rendered
}
