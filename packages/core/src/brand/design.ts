/// <reference path="../markdown.d.ts" />
export * as Design from "./design"

// User interface work: telling it apart from other work, the design guide
// that goes with it, and the layout plan asked for before anything is built.
// Pure, no I/O. The server applies it to each request
// (packages/opencode/src/rafiki/design.ts); the guide is also a built-in skill
// for a model that wants it on a task this module did not recognise.
import content from "./skill/design.md" with { type: "text" }

export const name = "ui-design"
export const description =
  "Use when building or restyling a user interface: pages, components, layouts, CSS, Tailwind, HTML. Rules for typography, spacing, colour, contrast, responsive layout, states and accessibility, and the render, screenshot and fix loop."
export const location = `/builtin/${name}.md`

let guideText: string | undefined
export function guide() {
  guideText ??= (content as string).replace(/^\s*<!--[\s\S]*?-->\s*/, "").trim()
  return guideText
}

// The "design" section of the configuration.
export interface Settings {
  guide?: boolean
  plan?: boolean
}

export function guideEnabled(settings: Settings | undefined) {
  return settings?.guide !== false
}

export function planEnabled(settings: Settings | undefined) {
  return settings?.plan !== false
}

// ---------------------------------------------------------------------------
// Detection. A request is UI work when its words say so, or when they lean
// that way and the files involved are mostly interface files. A hint, never a
// gate: a wrong guess costs one dismissed question.

// Words that on their own say the request is about an interface.
const STRONG = [
  /\bui\b/,
  /\bux\b/,
  /\buser interface/,
  /\bfront[- ]?end\b/,
  /\blanding page/,
  /\bhome ?page\b/,
  /\bweb ?page\b/,
  /\bweb ?site\b/,
  /\bcss\b/,
  /\bscss\b/,
  /\btailwind/,
  /\bstyl(e|es|ing|ed)\b.*\b(page|component|button|form|site|app|card|header|footer)/,
  /\bre-?style/,
  /\bre-?design/,
  /\blayout\b/,
  /\bresponsive\b/,
  /\bdashboard\b/,
  /\bnav ?bar\b|\bnavigation bar\b/,
  /\bhero (section|banner|image)\b/,
  /\bdark mode\b/,
  /\btypography\b/,
  /\bcolou?r (scheme|palette)\b/,
  /\bmock-?ups?\b/,
  /\bwireframe/,
  /\bfigma\b/,
  /\bdesign system\b/,
  /\blooks? (better|nicer|modern|good|bad|ugly|dated|clean)\b/,
  /\bvisual(ly)? design\b/,
  /\bpricing page\b/,
  /\b(sign[- ]?up|log[- ]?in|sign[- ]?in|settings|profile|checkout) (page|screen|form)\b/,
  /\bportfolio\b/,
]

// Words that lean towards an interface.
const WEAK = [
  /\bpage\b/,
  /\bscreen\b/,
  /\bbutton/,
  /\bform\b/,
  /\bcomponents?\b/,
  /\bdesign\b/,
  /\btheme\b/,
  /\bfont/,
  /\bicons?\b/,
  /\banimation/,
  /\bmodal\b/,
  /\bsidebar\b/,
  /\bcard\b/,
  /\bheader\b/,
  /\bfooter\b/,
  /\breact\b|\bvue\b|\bsvelte\b|\bnext\.?js\b|\bastro\b/,
  /\bhtml\b/,
  /\bbeautiful\b|\bpretty\b|\belegant\b|\bpolish/,
]

// Words that say the request is about something else.
const AGAINST = [
  /\b(api|system|database|schema|class|software|protocol|architecture) design\b/,
  /\bdesign (doc|document|pattern|review)/,
  /\bbug\b|\bcrash|\bexception\b|\bstack ?trace\b|\bsegfault\b/,
  /\b(unit|integration|failing) tests?\b/,
  /\bmigration\b|\bsql\b|\bendpoint\b|\bbackend\b|\bback-end\b/,
]

const FILE_STRONG = /\.(css|scss|sass|less|html?|vue|svelte|astro)$|(^|\/)(tailwind|postcss)\.config\.[cm]?[jt]s$/i
const FILE_WEAK = /\.(tsx|jsx)$/i
const FILE_UI_DIR = /(^|\/)(components?|pages|app|views|layouts?|ui|styles?|screens)\//i
const FILE_MENTION = /[\w@./-]+\.(?:css|scss|sass|less|html?|vue|svelte|astro|tsx|jsx)\b|(?:tailwind|postcss)\.config\.[cm]?[jt]s\b/gi

export interface Input {
  // The request as typed.
  text: string
  // Files involved: attached, named in the request, or changed in the session so far.
  files?: readonly string[]
}

function textScore(text: string) {
  const lower = text.toLowerCase()
  const strong = STRONG.filter((pattern) => pattern.test(lower)).length
  const weak = WEAK.filter((pattern) => pattern.test(lower)).length
  const against = AGAINST.filter((pattern) => pattern.test(lower)).length
  return strong + Math.min(weak, 3) * 0.5 - against * 1.5
}

// True when most files involved are interface files.
export function mostlyInterfaceFiles(files: readonly string[]) {
  const list = [...new Set(files.map((file) => file.replaceAll("\\", "/")))]
  if (list.length === 0) return false
  const weight = (file: string) =>
    FILE_STRONG.test(file) ? 1 : FILE_WEAK.test(file) ? (FILE_UI_DIR.test(file) ? 1 : 0.5) : 0
  const strong = list.some((file) => FILE_STRONG.test(file) || (FILE_WEAK.test(file) && FILE_UI_DIR.test(file)))
  return strong && list.reduce((sum, file) => sum + weight(file), 0) / list.length >= 0.6
}

export function detect(input: Input) {
  const mentioned = [...input.text.matchAll(FILE_MENTION)].map((match) => match[0])
  const files = [...(input.files ?? []), ...mentioned]
  return textScore(input.text) + (mostlyInterfaceFiles(files) ? 1 : 0) >= 1.5
}

// ---------------------------------------------------------------------------
// The layout plan.

// Words with which a request asks to build straight away.
const SKIP = [
  /\bno (layout )?plan\b/,
  /\b(skip|without) (the |a )?(layout )?plan\b/,
  /\b(just|directly|straight away|right away) (build|code|write|do|implement|make)\b/,
  /\b(build|code|implement|make) it (directly|now|straight away|right away)\b/,
  /\bdon'?t (ask|plan|wait)\b/,
]

export function skipPlan(text: string) {
  const lower = text.toLowerCase()
  return SKIP.some((pattern) => pattern.test(lower))
}

export const GUIDE_INTRO = "This request is user interface work. Follow this design guide for it:"

export const PLAN_NOTE = [
  "Before writing any code for this user interface request, reply with a short layout plan and stop:",
  "- the sections in order, top to bottom;",
  "- the components each one uses (the project's existing ones first);",
  "- the states to design (hover, focus, empty, loading, error);",
  "- how the layout changes on mobile, and the colour and type tokens you will use.",
  "Keep it under 25 lines, read the project's existing styles first if there are any, and write no files yet.",
  'End with one line: "Reply to build this, or say what to change."',
  "When the person approves it, build it and follow the loop of the design guide; when they ask for changes, revise the plan first.",
].join("\n")
