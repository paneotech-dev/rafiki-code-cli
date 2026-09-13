// Gateway (LiteLLM) failures mapped to the contract's surface codes, messages
// and exit codes (platform/docs/rafiki-code-contract-v1.md, Gateway usage and
// Error taxonomy). Called from the provider error path for the Rafiki
// provider only; every other provider keeps upstream behaviour.
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Contract from "./contract"

export interface GatewayFailure {
  code: string
  message: string
  exitCode: number
  isRetryable: boolean
}

export interface GatewayErrorInput {
  message?: string
  statusCode?: number
  responseBody?: string
  responseHeaders?: Record<string, string>
}

function parse(body?: string): { type?: string; message?: string } {
  if (!body) return {}
  try {
    const raw = JSON.parse(body)
    const error = raw && typeof raw === "object" ? (raw.error ?? raw) : undefined
    if (!error || typeof error !== "object") return {}
    return {
      type: typeof error.type === "string" ? error.type : undefined,
      message: typeof error.message === "string" ? error.message : undefined,
    }
  } catch {
    return {}
  }
}

function keysPage() {
  return Brand.consoleURL() + Contract.PATH.keysPage
}

function withConsole(message: string) {
  // The contract writes the production host into its messages; on another
  // Console (staging, a local mock) the link must still be the right one.
  return message.replace("console.rafikiai.io/keys", keysPage().replace(/^https?:\/\//, ""))
}

function tierFrom(message?: string) {
  // LiteLLM lists the allowed models first and the refused one last
  // ("... Tried to access rafiki-max"), so the last alias is the one asked for.
  const tried = message?.match(/Tried to access rafiki-(fast|pro|max)/i)
  if (tried) return tried[1]!
  const all = [...(message?.matchAll(/rafiki-(fast|pro|max)/g) ?? [])]
  return all.at(-1)?.[1] ?? "requested"
}

function retryAfter(headers?: Record<string, string>) {
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"]
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? String(Math.ceil(seconds)) : "a few"
}

// The AI SDK reports a refused, reset or unresolvable connection as an API
// call error with no status and this message prefix.
const UNREACHABLE = /^Cannot connect to API\b/i
// Session errors built from socket and stream failures, not HTTP answers.
const NETWORK_CODES = new Set(["ECONNRESET", "ProviderHeaderTimeoutError", "ProviderResponseStreamError"])

export function unreachableMessage(detail?: string) {
  const override = process.env[Brand.env.gatewayURL] ? `, and ${Brand.env.gatewayURL} which is set` : ""
  const cause = detail ? ` (${detail.replace(UNREACHABLE, "").replace(/^[:\s]+/, "")})` : ""
  return `Cannot reach the model gateway at ${Brand.gatewayURL()}${cause}. Check the network${override}.`
}

// Undefined means "not a condition the contract names": upstream handling applies.
export function classify(input: GatewayErrorInput): GatewayFailure | undefined {
  const status = input.statusCode
  if (!status && UNREACHABLE.test(input.message ?? "")) {
    return {
      code: Contract.ERROR.gatewayUnavailable,
      message: unreachableMessage(input.message),
      exitCode: Contract.EXIT.network,
      isRetryable: true,
    }
  }
  if (!status) return undefined
  const body = parse(input.responseBody)

  if (status === 429 && body.type === Contract.GATEWAY_ERROR_TYPE.budgetExceeded) {
    return {
      code: Contract.ERROR.keyBudgetExhausted,
      message: withConsole(Contract.MESSAGE[Contract.ERROR.keyBudgetExhausted]!),
      exitCode: Contract.EXIT.wallet,
      isRetryable: false,
    }
  }
  if (status === 401) {
    return {
      code: Contract.ERROR.keyRevoked,
      message: Brand.hasKey()
        ? Contract.MESSAGE[Contract.ERROR.keyRevoked]!
        : `Not signed in. Run ${Brand.name} login, or set ${Brand.env.apiKey} for servers and CI.`,
      exitCode: Contract.EXIT.usage,
      isRetryable: false,
    }
  }
  if (status === 403) {
    const denied = body.type === Contract.GATEWAY_ERROR_TYPE.keyModelAccessDenied || /not allowed to access model/i.test(body.message ?? "")
    if (denied) {
      return {
        code: Contract.ERROR.tierNotAllowed,
        message: withConsole(Contract.MESSAGE[Contract.ERROR.tierNotAllowed]!.replace("<tier>", tierFrom(body.message))),
        exitCode: Contract.EXIT.usage,
        isRetryable: false,
      }
    }
  }
  if (status === 429) {
    return {
      code: Contract.ERROR.rateLimited,
      message: Contract.MESSAGE[Contract.ERROR.rateLimited]!.replace("<n>", retryAfter(input.responseHeaders)),
      exitCode: Contract.EXIT.network,
      isRetryable: true,
    }
  }
  if (status === 504 || status === 408) {
    return {
      code: Contract.ERROR.requestTimeout,
      message: Contract.MESSAGE[Contract.ERROR.requestTimeout]!,
      exitCode: Contract.EXIT.network,
      isRetryable: true,
    }
  }
  if (status >= 500) {
    return {
      code: Contract.ERROR.gatewayUnavailable,
      message: Contract.MESSAGE[Contract.ERROR.gatewayUnavailable]!,
      exitCode: Contract.EXIT.network,
      isRetryable: true,
    }
  }
  return undefined
}

// True when the error belongs to the Rafiki gateway provider.
export function isRafikiProvider(providerID: string) {
  return providerID === Brand.provider.id
}

// The exit code for a session error object as the run command sees it
// (`{ name, data: { statusCode, responseBody, metadata } }`), or undefined
// when it is not a gateway condition the contract maps.
export function exitCodeFor(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const data = (error as { data?: Record<string, unknown> }).data
  if (!data || typeof data !== "object") return undefined
  const metadata = data["metadata"] as Record<string, unknown> | undefined
  const code = metadata?.["rafiki_code"]
  if (typeof code === "string") {
    if (code === Contract.ERROR.keyBudgetExhausted) return Contract.EXIT.wallet
    if (code === Contract.ERROR.keyRevoked || code === Contract.ERROR.tierNotAllowed) return Contract.EXIT.usage
    return Contract.EXIT.network
  }
  // Connection failures that never produced an HTTP answer are network class too.
  if ((error as { name?: string }).name === "APIError" && data["statusCode"] === undefined) {
    if (typeof metadata?.["code"] === "string" && NETWORK_CODES.has(metadata["code"])) return Contract.EXIT.network
    if (typeof data["message"] === "string" && UNREACHABLE.test(data["message"])) return Contract.EXIT.network
  }
  return undefined
}

// A budget, revocation or tier refusal does not fix itself: the retry policy
// must not wait on it, whatever the body text pattern-matches.
export function neverRetry(error: unknown): boolean {
  const code = exitCodeFor(error)
  return code === Contract.EXIT.wallet || code === Contract.EXIT.usage
}

export function annotate(failure: GatewayFailure, metadata?: Record<string, string>): Record<string, string> {
  return { ...(metadata ?? {}), rafiki_code: failure.code }
}
