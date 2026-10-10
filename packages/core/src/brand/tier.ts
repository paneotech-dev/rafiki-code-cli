// What a person is told when choosing a tier: its price in credits, the one
// confirmation before a session moves to Rafiki Max, and what to do when the
// key in use was approved without the tier. Pure, no I/O: the key's allowed
// models come from the gateway's /key/info answer (account.ts keyInfo).
//
// The credit rates are the ones the approval page of the Console states next
// to each tier: fast 1x, pro 4x, max 15x. Rafiki Fast stays the default tier;
// Rafiki Max is offered to everyone and is never chosen without a confirmation.
import { Brand } from "./brand"

export const CREDITS: Record<string, number> = {
  "rafiki-fast": 1,
  "rafiki-pro": 4,
  "rafiki-max": 15,
}

// The tier that asks for a confirmation the first time a session switches to it.
export const CONFIRM = "rafiki-max"

const LABEL: Record<string, string> = {
  "rafiki-fast": "Rafiki Fast",
  "rafiki-pro": "Rafiki Pro",
  "rafiki-max": "Rafiki Max",
}

// "15x credits", or undefined for a model that is not a Rafiki tier.
export function credits(model: string | undefined): string | undefined {
  const rate = model ? CREDITS[model] : undefined
  return rate === undefined ? undefined : `${rate}x credits`
}

export function label(model: string) {
  return LABEL[model] ?? model
}

// True when choosing this model needs the confirmation first.
export function needsConfirm(providerID: string, modelID: string) {
  return providerID === Brand.provider.id && modelID === CONFIRM
}

export function confirmTitle(model: string = CONFIRM) {
  return `Switch to ${label(model)}?`
}

export function confirmMessage(model: string = CONFIRM) {
  const rate = CREDITS[model] ?? 1
  return `${label(model)} uses ${rate}x credits: each request costs ${rate} times what the same request costs on Rafiki Fast. This session stays on ${label(model)} until you pick another tier.`
}

// LiteLLM spells "every model" as an empty list or one of these markers.
const ALL_MODELS = new Set(["all-proxy-models", "all-team-models"])

// Whether a key may use a model, from the models list of its /key/info
// answer: true or false when the list says so, undefined when it does not
// (no answer, an empty list or a marker meaning every model).
export function allows(models: readonly string[] | undefined, model: string): boolean | undefined {
  if (!models || models.length === 0) return undefined
  if (models.some((item) => ALL_MODELS.has(item))) return undefined
  return models.includes(model)
}

// The tier name as the approval page shows it next to its box: Max.
function boxName(model: string) {
  const tier = Brand.provider.tier(model)
  return tier ? tier[0]!.toUpperCase() + tier.slice(1) : model
}

// What to say when the key was approved without the tier.
export function notOnKeyMessage(model: string) {
  return `This key was approved without the ${label(model)} tier, so the gateway will refuse ${model}. Run ${Brand.name} login again and tick ${boxName(model)} on the approval page, then pick ${label(model)} again.`
}
