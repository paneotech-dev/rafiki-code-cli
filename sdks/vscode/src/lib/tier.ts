// The three Rafiki tiers and the model each one selects for a new session.
export const TIERS = ["fast", "pro", "max"] as const
export type Tier = (typeof TIERS)[number]
// "default" leaves the choice to rafikicode (its configured model, rafiki-fast
// out of the box).
export type TierSetting = Tier | "default"

export const TIER_INFO: Record<Tier, { label: string; detail: string; multiplier: string }> = {
  fast: {
    label: "Fast",
    detail: "rafiki-fast: everyday coding at the lowest credit cost",
    multiplier: "1x credits",
  },
  pro: {
    label: "Pro",
    detail: "rafiki-pro: long agentic tasks",
    multiplier: "4x credits",
  },
  max: {
    label: "Max",
    detail: "rafiki-max: frontier models for the hardest problems",
    multiplier: "15x credits",
  },
}

// Tiers left out of the tier picker while unavailable, the same switch as
// Brand.provider.unlisted in the CLI: make the list empty to offer every tier
// again. A tier set explicitly in the settings still starts sessions on it.
export const UNLISTED_TIERS: readonly Tier[] = ["max"]

// The tiers the picker offers, plus the current one when it is unlisted.
export function offeredTiers(current?: TierSetting, unlisted: readonly Tier[] = UNLISTED_TIERS): Tier[] {
  return TIERS.filter((t) => !unlisted.includes(t) || t === current)
}

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value)
}

export function normalizeTier(value: unknown): TierSetting {
  return isTier(value) ? value : "default"
}

// The --model value for a tier, or undefined to keep the rafikicode default.
export function modelFor(tier: TierSetting) {
  return isTier(tier) ? `rafiki/rafiki-${tier}` : undefined
}
