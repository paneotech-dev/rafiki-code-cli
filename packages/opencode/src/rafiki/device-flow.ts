// Device flow client for the Console (RFC 8628 shaped, see contract.ts).
// Plain async code on top of fetch so it is easy to drive from tests with a
// mock Console; the commands wrap it in Effect.
import os from "os"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Credentials from "@opencode-ai/core/brand/credentials"
import * as Contract from "./contract"

export class DeviceFlowError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exitCode: number,
    readonly ref?: string,
  ) {
    super(message)
    this.name = "DeviceFlowError"
  }
}

export interface Env {
  readonly [key: string]: string | undefined
}

// Headless means: a key is already set, or there is no terminal to read a
// code from, or a CI variable is present. The test hook lets subprocess
// tests exercise the interactive path without a pseudo terminal.
export function headless(env: Env = process.env, isTTY: boolean = Boolean(process.stdin.isTTY)) {
  if (env[Brand.env.apiKey]) return "key"
  if (env["CI"]) return "ci"
  if (!isTTY && !env["RAFIKICODE_TEST_TTY"]) return "tty"
  return undefined
}

export function headlessMessage(reason: "key" | "ci" | "tty") {
  const lines =
    reason === "key"
      ? [`${Brand.env.apiKey} is set, so this session is already authenticated with a server key.`]
      : [
          reason === "ci"
            ? "This looks like a CI environment, so the browser sign-in is not available."
            : "No terminal is attached, so the browser sign-in is not available.",
          `Create a server key at ${Brand.consoleURL()}${Contract.PATH.keysPage} and set ${Brand.env.apiKey}:`,
          `  export ${Brand.env.apiKey}=sk-...`,
        ]
  return lines.join("\n")
}

export function deviceLabel(version: string, override?: string) {
  const label = (override?.trim() || `${Brand.name} ${version} on ${os.hostname()}`).slice(0, Contract.DEVICE_LABEL_MAX)
  return label
}

async function parse(response: Response): Promise<{ body: any; error?: Contract.ErrorEnvelope["error"]; ref?: string }> {
  const text = await response.text()
  let body: any = undefined
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  const envelope = body && typeof body === "object" ? (body as Contract.ErrorEnvelope) : undefined
  return { body, error: envelope?.error, ref: envelope?.ref }
}

function failure(status: number, error: Contract.ErrorEnvelope["error"], ref: string | undefined, fallback: string) {
  const code = error?.code || error?.type || (status >= 500 ? "internal" : "invalid_request")
  const message = Contract.MESSAGE[code] || error?.message || fallback
  const exitCode =
    status === 401 || code === Contract.ERROR.unauthenticated || code === Contract.ERROR.keyRevoked
      ? Contract.EXIT.usage
      : status === 402
        ? Contract.EXIT.wallet
        : status >= 500
          ? Contract.EXIT.network
          : Contract.EXIT.failed
  return new DeviceFlowError(message, code, exitCode, ref)
}

function network(cause: unknown, what: string) {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new DeviceFlowError(`Could not reach the Console to ${what}: ${detail}`, "network", Contract.EXIT.network)
}

export interface Client {
  readonly consoleURL: string
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
}

export function client(overrides: Partial<Client> = {}): Client {
  return {
    consoleURL: Brand.consoleURL(),
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    ...overrides,
  }
}

export async function requestCode(
  c: Client,
  input: { label: string; tiers?: readonly string[] },
): Promise<Required<Pick<Contract.DeviceCodeResponse, "device_code" | "user_code" | "verification_uri">> &
  Contract.DeviceCodeResponse & { interval: number; expires_in: number }> {
  let response: Response
  try {
    response = await c.fetch(c.consoleURL + Contract.PATH.deviceCode, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: Contract.CLIENT_ID,
        surface: Contract.SURFACE,
        device_label: input.label,
        requested_tiers: input.tiers ?? Contract.TIERS,
      }),
    })
  } catch (cause) {
    throw network(cause, "start the sign-in")
  }
  const { body, error, ref } = await parse(response)
  if (!response.ok) throw failure(response.status, error, ref, "The Console refused to start the sign-in.")
  if (!body?.device_code || !body?.user_code || !body?.verification_uri) {
    throw new DeviceFlowError("The Console sent an unexpected reply.", "invalid_response", Contract.EXIT.internal)
  }
  return {
    ...body,
    interval: typeof body.interval === "number" && body.interval > 0 ? body.interval : Contract.DEFAULT_INTERVAL,
    expires_in: typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : Contract.DEFAULT_EXPIRES_IN,
  }
}

export interface PollEvents {
  onPending?: (state: { interval: number }) => void
  onSlowDown?: (state: { interval: number }) => void
  onRateLimited?: (state: { retryAfter: number }) => void
}

// Poll the token endpoint until the Console delivers a key or the code dies.
// Follows the contract table: pending keeps going, slow_down adds the
// increment, 429 waits Retry-After, everything else stops.
export async function pollToken(
  c: Client,
  code: { device_code: string; interval: number; expires_in: number },
  events: PollEvents = {},
): Promise<Contract.TokenResponse> {
  let interval = code.interval
  const deadline = c.now() + code.expires_in * 1000
  while (true) {
    await c.sleep(interval * 1000)
    if (c.now() > deadline) {
      throw new DeviceFlowError(Contract.MESSAGE[Contract.ERROR.expiredToken], Contract.ERROR.expiredToken, Contract.EXIT.usage)
    }
    let response: Response
    try {
      response = await c.fetch(c.consoleURL + Contract.PATH.deviceToken, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          grant_type: Contract.GRANT_TYPE,
          device_code: code.device_code,
          client_id: Contract.CLIENT_ID,
        }),
      })
    } catch (cause) {
      throw network(cause, "finish the sign-in")
    }
    const { body, error, ref } = await parse(response)
    if (response.ok) {
      if (!body?.access_token) {
        throw new DeviceFlowError("The Console sent an unexpected reply.", "invalid_response", Contract.EXIT.internal)
      }
      return body as Contract.TokenResponse
    }
    const errorCode = error?.code || error?.type
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after")) || interval
      events.onRateLimited?.({ retryAfter })
      await c.sleep(Math.max(0, retryAfter - interval) * 1000)
      continue
    }
    if (errorCode === Contract.ERROR.authorizationPending) {
      events.onPending?.({ interval })
      continue
    }
    if (errorCode === Contract.ERROR.slowDown) {
      interval += Contract.SLOW_DOWN_INCREMENT
      events.onSlowDown?.({ interval })
      continue
    }
    if (errorCode === Contract.ERROR.accessDenied) {
      throw new DeviceFlowError(Contract.MESSAGE[errorCode], errorCode, Contract.EXIT.failed, ref)
    }
    if (errorCode === Contract.ERROR.expiredToken || errorCode === Contract.ERROR.invalidGrant) {
      throw new DeviceFlowError(Contract.MESSAGE[errorCode], errorCode, Contract.EXIT.usage, ref)
    }
    throw failure(response.status, error, ref, "The Console refused the sign-in.")
  }
}

export function toCredential(token: Contract.TokenResponse, now: number = Date.now()): Credentials.StoredCredential {
  const created = new Date(now)
  return {
    version: 1,
    key: token.access_token,
    key_id: token.key_id,
    key_alias: token.key_alias,
    kind: "session",
    gateway_url: token.gateway_url || Brand.gateway.url,
    console_url: token.console_url || Brand.consoleURL(),
    scope: token.scope,
    owner: token.owner,
    expires_at: token.expires_in ? new Date(now + token.expires_in * 1000).toISOString() : undefined,
    created_at: created.toISOString(),
  }
}

function bearer(key: string) {
  return { authorization: `Bearer ${key}`, accept: "application/json" }
}

export async function me(c: Client, key: string): Promise<Contract.MeResponse> {
  let response: Response
  try {
    response = await c.fetch(c.consoleURL + Contract.PATH.me, { headers: bearer(key) })
  } catch (cause) {
    throw network(cause, "load the account")
  }
  const { body, error, ref } = await parse(response)
  if (!response.ok) throw failure(response.status, error, ref, "The Console could not load the account.")
  return body as Contract.MeResponse
}

export async function revoke(c: Client, key: string, keyID: string): Promise<void> {
  let response: Response
  try {
    response = await c.fetch(c.consoleURL + Contract.PATH.keys + "/" + encodeURIComponent(keyID), {
      method: "DELETE",
      headers: bearer(key),
    })
  } catch (cause) {
    throw network(cause, "revoke the key")
  }
  // 401 and 404 mean the key is already gone, which is what logout wants.
  if (response.ok || response.status === 401 || response.status === 404) return
  const { error, ref } = await parse(response)
  throw failure(response.status, error, ref, "The Console could not revoke the key.")
}

export async function refresh(c: Client, key: string): Promise<Contract.TokenResponse> {
  let response: Response
  try {
    response = await c.fetch(c.consoleURL + Contract.PATH.deviceRefresh, {
      method: "POST",
      headers: { ...bearer(key), "content-type": "application/json" },
      body: "{}",
    })
  } catch (cause) {
    throw network(cause, "rotate the key")
  }
  const { body, error, ref } = await parse(response)
  if (!response.ok) throw failure(response.status, error, ref, "The Console could not rotate the key.")
  if (!body?.access_token) {
    throw new DeviceFlowError("The Console sent an unexpected reply.", "invalid_response", Contract.EXIT.internal)
  }
  return body as Contract.TokenResponse
}

// Rotation policy from the contract: within the refresh window, at most once
// per hour, session keys only (server keys come from the env var and are
// never rotated here).
export function shouldRefresh(credential: Credentials.StoredCredential, now: number = Date.now(), force = false) {
  if (!credential.expires_at) return false
  const expires = Date.parse(credential.expires_at)
  if (Number.isNaN(expires)) return false
  const last = credential.refreshed_at ? Date.parse(credential.refreshed_at) : Number.NaN
  const tooSoon = !Number.isNaN(last) && now - last < Contract.REFRESH_MIN_GAP_SECONDS * 1000
  if (tooSoon) return false
  if (force) return true
  return expires - now <= Contract.REFRESH_WINDOW_SECONDS * 1000
}
