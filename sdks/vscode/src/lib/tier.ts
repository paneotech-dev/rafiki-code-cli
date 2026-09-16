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
