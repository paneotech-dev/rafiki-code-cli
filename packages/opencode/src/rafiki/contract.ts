// Everything rafikicode knows about the Console wire contract, in one file.
// Source: platform/docs/rafiki-code-contract-v1.md, sections Device flow,
// Keys, Error taxonomy. The contract is a draft until sign-off; if a path,
// field, interval or message changes at sign-off, this file is the only one
// that needs editing.

export const CLIENT_ID = "rafikicode"
export const SURFACE = "cli"
export const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"

export const TIERS = ["fast", "pro", "max"] as const
export type Tier = (typeof TIERS)[number]

export const PATH = {
  deviceCode: "/api/v1/device/code",
  deviceToken: "/api/v1/device/token",
  deviceRefresh: "/api/v1/device/refresh",
  verify: "/device",
  me: "/api/v1/me",
  keys: "/api/v1/keys",
  keysPage: "/keys",
} as const

// Seconds added to the polling interval on every slow_down.
export const SLOW_DOWN_INCREMENT = 5
// Fallback when the server omits interval or expires_in (the contract values).
export const DEFAULT_INTERVAL = 5
export const DEFAULT_EXPIRES_IN = 600
// Rotate when the key expires within this window, and never more than once an hour.
export const REFRESH_WINDOW_SECONDS = 7 * 24 * 3600
export const REFRESH_MIN_GAP_SECONDS = 3600
// Device label length cap on the wire.
export const DEVICE_LABEL_MAX = 120

export const ERROR = {
  authorizationPending: "authorization_pending",
  slowDown: "slow_down",
  accessDenied: "access_denied",
  expiredToken: "expired_token",
  invalidGrant: "invalid_grant",
  unsupportedGrantType: "unsupported_grant_type",
  unknownClient: "unknown_client",
  invalidRequest: "invalid_request",
  rateLimited: "rate_limited",
  serviceUnavailable: "service_unavailable",
  unauthenticated: "unauthenticated",
  keyRevoked: "key_revoked",
  wrongKeyKind: "wrong_key_kind",
} as const

// Messages the CLI prints for conditions the user must act on. The Console
// sends its own text too; the local copy covers old servers and offline paths.
export const MESSAGE: Record<string, string> = {
  [ERROR.accessDenied]: "Sign-in was denied in the browser.",
  [ERROR.expiredToken]: "That sign-in code expired. Run rafikicode login again.",
  [ERROR.invalidGrant]: "That sign-in code is not valid.",
  [ERROR.unknownClient]: "Unknown client.",
  [ERROR.unauthenticated]: "Missing API key. Run rafikicode login, or set RAFIKICODE_API_KEY.",
  [ERROR.keyRevoked]: "This key was revoked or has expired. Run rafikicode login.",
  [ERROR.wrongKeyKind]: "This key cannot be refreshed here. Create a new key at console.rafikiai.io/keys.",
  [ERROR.serviceUnavailable]: "The service is not available.",
}

// CLI exit codes from the contract: scripts branch on these.
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  wallet: 3,
  network: 4,
  internal: 5,
} as const

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in?: number
  interval?: number
}

export interface Owner {
  id: string
  email?: string
  name?: string
}

export interface Limits {
  max_budget_usd?: number | null
  spend_usd?: number
  budget_duration?: string | null
  rpm_limit?: number | null
  tpm_limit?: number | null
}

export interface TokenResponse {
  access_token: string
  token_type: string
  expires_in?: number
  scope?: string
  key_id?: string
  key_alias?: string
  gateway_url?: string
  console_url?: string
  owner?: Owner
  limits?: Limits
}

export interface MeResponse {
  object?: "me"
  owner: Owner
  key?: { id?: string; alias?: string; name?: string; kind?: string; created_at?: string; expires_at?: string }
  wallet?: { balance_usd?: number; credited_usd?: number; spent_usd?: number }
  limits?: Limits
  tiers?: string[]
}

export interface ErrorEnvelope {
  error?: { message?: string; type?: string; code?: string; retryable?: boolean }
  ref?: string
  correlation_id?: string
}
