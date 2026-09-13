// The contract's gateway error mapping: LiteLLM conditions to surface codes,
// messages, exit codes and retryability.
import { describe, expect, test } from "bun:test"
import * as GatewayErrors from "../../src/rafiki/gateway-errors"
import * as Contract from "../../src/rafiki/contract"

const body = (type: string, message: string) => JSON.stringify({ error: { message, type, param: null, code: "400" } })

describe("gateway error mapping", () => {
  test("a 429 budget_exceeded is key_budget_exhausted, exit 3, not retryable", () => {
    const f = GatewayErrors.classify({ statusCode: 429, responseBody: body("budget_exceeded", "Budget has been exceeded! Current cost: 2.6, Max budget: 2.5") })
    expect(f?.code).toBe("key_budget_exhausted")
    expect(f?.exitCode).toBe(Contract.EXIT.wallet)
    expect(f?.isRetryable).toBe(false)
    expect(f?.message).toContain("run out of budget")
    expect(f?.message).toContain("/keys")
    expect(f?.message).not.toContain("Budget has been exceeded")
  })

  test("a 401 is key_revoked with the login instruction", () => {
    const before = process.env["RAFIKICODE_API_KEY"]
    process.env["RAFIKICODE_API_KEY"] = "sk-test"
    const f = GatewayErrors.classify({ statusCode: 401, responseBody: body("auth_error", "token_not_found_in_db") })
    if (before === undefined) delete process.env["RAFIKICODE_API_KEY"]
    else process.env["RAFIKICODE_API_KEY"] = before
    expect(f?.code).toBe("key_revoked")
    expect(f?.exitCode).toBe(Contract.EXIT.usage)
    expect(f?.message).toBe("This key was revoked or has expired. Run rafikicode login.")
  })

  test("a 401 without any key says sign in first", () => {
    const before = process.env["RAFIKICODE_API_KEY"]
    delete process.env["RAFIKICODE_API_KEY"]
    const f = GatewayErrors.classify({ statusCode: 401, responseBody: body("auth_error", "token_not_found_in_db") })
    if (before !== undefined) process.env["RAFIKICODE_API_KEY"] = before
    expect(f?.code).toBe("key_revoked")
    expect(f?.message).toBe("Not signed in. Run rafikicode login, or set RAFIKICODE_API_KEY for servers and CI.")
  })

  test("a 403 key_model_access_denied names the tier", () => {
    const f = GatewayErrors.classify({
      statusCode: 403,
      responseBody: body("key_model_access_denied", "key not allowed to access model. This key can only access models=['rafiki-fast']. Tried to access rafiki-max"),
    })
    expect(f?.code).toBe("tier_not_allowed")
    expect(f?.message).toContain("the max tier")
    expect(f?.isRetryable).toBe(false)
  })

  test("other 429s are rate_limited with the Retry-After figure, 5xx is gateway_unavailable, 504 is a timeout", () => {
    const rate = GatewayErrors.classify({ statusCode: 429, responseBody: body("rate_limit_error", "slow"), responseHeaders: { "retry-after": "7" } })
    expect(rate?.code).toBe("rate_limited")
    expect(rate?.message).toBe("Too many requests. Try again in 7 seconds.")
    expect(rate?.isRetryable).toBe(true)
    expect(GatewayErrors.classify({ statusCode: 503, responseBody: "" })?.code).toBe("gateway_unavailable")
    expect(GatewayErrors.classify({ statusCode: 502, responseBody: "<html>bad gateway</html>" })?.code).toBe("gateway_unavailable")
    expect(GatewayErrors.classify({ statusCode: 504 })?.code).toBe("request_timeout")
  })

  test("anything else is left to upstream", () => {
    expect(GatewayErrors.classify({ statusCode: 400, responseBody: body("invalid_request_error", "bad") })).toBeUndefined()
    expect(GatewayErrors.classify({ statusCode: 403, responseBody: body("permission_error", "nope") })).toBeUndefined()
    expect(GatewayErrors.classify({ statusCode: 404 })).toBeUndefined()
    expect(GatewayErrors.classify({})).toBeUndefined()
  })

  test("exit codes are read back from the annotated session error", () => {
    const wallet = { name: "APIError", data: { message: "x", metadata: { rafiki_code: "key_budget_exhausted" } } }
    expect(GatewayErrors.exitCodeFor(wallet)).toBe(3)
    expect(GatewayErrors.exitCodeFor({ name: "APIError", data: { metadata: { rafiki_code: "key_revoked" } } })).toBe(2)
    expect(GatewayErrors.exitCodeFor({ name: "APIError", data: { metadata: { rafiki_code: "gateway_unavailable" } } })).toBe(4)
    expect(GatewayErrors.exitCodeFor({ name: "APIError", data: { message: "plain" } })).toBeUndefined()
    expect(GatewayErrors.exitCodeFor(undefined)).toBeUndefined()
  })

  test("the provider check is by id", () => {
    expect(GatewayErrors.isRafikiProvider("rafiki")).toBe(true)
    expect(GatewayErrors.isRafikiProvider("openai")).toBe(false)
  })
})
