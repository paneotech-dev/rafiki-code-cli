// The key only travels encrypted (L-R2-7): RAFIKICODE_GATEWAY_URL, the gateway
// URL the Console returns at login and a base URL in the user's own config are
// used only when https, or plain http to this machine. The request guard also
// reads byte and form bodies for the key (B1 remainder).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Credentials from "@opencode-ai/core/brand/credentials"
import * as Guard from "@opencode-ai/core/brand/guard"
import { toCredential } from "../../src/rafiki/device-flow"
import { classify } from "../../src/rafiki/gateway-errors"

const names = [Brand.env.gatewayURL, Brand.env.apiKey]
const saved: Record<string, string | undefined> = {}
const stubKey = "sk-scheme-test-not-a-real-key-000000"
const refusedURLs = [
  "http://gateway.example.com/v1",
  "http://10.255.255.1:4197/v1",
  "ftp://gateway.example.com/v1",
  "https://user:pass@gateway.example.com/v1",
  "http://127.0.0.1.nip.io/v1",
  "not a url",
]
const allowedURLs = ["https://gateway.example.com/v1", "http://127.0.0.1:4197/v1", "http://localhost:4197/v1", "http://[::1]:4197/v1"]

beforeEach(() => {
  for (const n of names) {
    saved[n] = process.env[n]
    delete process.env[n]
  }
  Guard.resetTrust()
})

afterEach(() => {
  for (const n of names) {
    if (saved[n] === undefined) delete process.env[n]
    else process.env[n] = saved[n]
  }
  Guard.resetTrust()
  Credentials.remove(Brand.configDir())
})

describe("gateway URL scheme", () => {
  test("RAFIKICODE_GATEWAY_URL is used only when https or on this machine", () => {
    for (const url of allowedURLs) {
      process.env[Brand.env.gatewayURL] = url
      expect(Brand.gatewayURL(), url).toBe(url)
      expect(Brand.gatewayProblem(), url).toBeUndefined()
    }
    for (const url of refusedURLs) {
      process.env[Brand.env.gatewayURL] = url
      expect(Brand.gatewayURL(), url).toBe(Brand.gateway.url)
      expect(Brand.gatewayProblem(), url).toContain(`${Brand.env.gatewayURL} must be an https URL`)
      expect([...Guard.gatewayOrigins()], url).toEqual([new URL(Brand.gateway.url).origin])
    }
  })

  test("the login URL from the Console is stored and used only when https or on this machine", () => {
    const token = (gateway_url: string) => ({ access_token: stubKey, gateway_url }) as any
    expect(toCredential(token("http://gateway.example.com/v1")).gateway_url).toBe(Brand.gateway.url)
    expect(toCredential(token("https://gateway.example.com/v1")).gateway_url).toBe("https://gateway.example.com/v1")
    expect(toCredential(token("http://127.0.0.1:4181/v1")).gateway_url).toBe("http://127.0.0.1:4181/v1")
    // A credential file written by an older version with an http URL.
    Credentials.write(Brand.configDir(), { ...toCredential(token("https://gateway.example.com/v1")), gateway_url: "http://gateway.example.com/v1" })
    expect(Brand.gatewayURL()).toBe(Brand.gateway.url)
  })

  test("a user config base URL on plain http elsewhere is not trusted with the key", () => {
    process.env[Brand.env.apiKey] = stubKey
    const auth = { Authorization: `Bearer ${stubKey}` }
    Guard.trust({ provider: { rafiki: { options: { baseURL: "http://gateway.example.com/v1" } } } })
    expect(() => Guard.request("http://gateway.example.com/v1/chat/completions", { headers: auth })).toThrow(Guard.KeyLeakError)
    Guard.trust({ provider: { rafiki: { options: { baseURL: "https://mirror.example.com/v1" } } } })
    expect(() => Guard.request("https://mirror.example.com/v1/chat/completions", { headers: auth })).not.toThrow()
  })
})

describe("Console URL scheme", () => {
  const consoleDefault = "https://console.rafikiai.io"
  const refusedConsoleURLs = [
    "http://console.example.com",
    "http://172.17.0.1:4108",
    "ftp://console.example.com",
    "https://user:pass@console.example.com",
    "http://127.0.0.1.nip.io",
    "not a url",
  ]
  const allowedConsoleURLs = ["https://console.example.com", "http://127.0.0.1:4181", "http://localhost:4181", "http://[::1]:4181"]
  const saveConsole = { value: undefined as string | undefined }
  beforeEach(() => {
    saveConsole.value = process.env[Brand.env.consoleURL]
    delete process.env[Brand.env.consoleURL]
  })
  afterEach(() => {
    if (saveConsole.value === undefined) delete process.env[Brand.env.consoleURL]
    else process.env[Brand.env.consoleURL] = saveConsole.value
  })

  test("RAFIKICODE_CONSOLE_URL is used only when https or on this machine", () => {
    for (const url of allowedConsoleURLs) {
      process.env[Brand.env.consoleURL] = url + "/"
      expect(Brand.consoleURL(), url).toBe(url)
      expect(Brand.consoleProblem(), url).toBeUndefined()
    }
    for (const url of refusedConsoleURLs) {
      process.env[Brand.env.consoleURL] = url
      expect(Brand.consoleURL(), url).toBe(consoleDefault)
      expect(Brand.consoleProblem(), url).toContain(`${Brand.env.consoleURL} must be an https URL`)
    }
  })

  test("the Console URL from a login is stored and used only when https or on this machine", () => {
    const token = (console_url: string) => ({ access_token: stubKey, console_url }) as any
    expect(toCredential(token("http://console.example.com")).console_url).toBe(consoleDefault)
    expect(toCredential(token("https://console.example.com")).console_url).toBe("https://console.example.com")
    expect(toCredential(token("http://127.0.0.1:4181")).console_url).toBe("http://127.0.0.1:4181")
    // A credential file written by an older version with an http URL elsewhere.
    expect(Brand.consoleFor("http://console.example.com")).toBe(consoleDefault)
    expect(Brand.consoleFor("https://console.example.com/")).toBe("https://console.example.com")
    expect(Brand.consoleFor(undefined)).toBe(consoleDefault)
  })

  test("the budget message links to the key page of the Console that issued the stored login", () => {
    Credentials.write(Brand.configDir(), { ...toCredential({ access_token: stubKey, console_url: "https://console.staging.example" } as any) })
    const failure = classify({ statusCode: 429, responseBody: JSON.stringify({ error: { type: "budget_exceeded", message: "Budget has been exceeded" } }) })
    expect(failure?.message).toContain("console.staging.example/keys")
    expect(failure?.message).not.toContain("console.rafikiai.io/keys")
    process.env[Brand.env.apiKey] = stubKey
    const serverKey = classify({ statusCode: 429, responseBody: JSON.stringify({ error: { type: "budget_exceeded", message: "Budget has been exceeded" } }) })
    expect(serverKey?.message).toContain("console.rafikiai.io/keys")
  })
})

describe("request guard bodies", () => {
  test("the key in a byte, URL encoded or form body is refused on the way to another host", () => {
    process.env[Brand.env.apiKey] = stubKey
    const text = JSON.stringify({ api_key: stubKey })
    const bytes = new TextEncoder().encode(text)
    const form = new FormData()
    form.set("key", stubKey)
    for (const body of [bytes, bytes.buffer, new DataView(bytes.buffer), new URLSearchParams({ key: stubKey }), form, text]) {
      expect(() => Guard.request("https://attacker.example/v1", { body }), String(body)).toThrow(Guard.KeyLeakError)
      expect(() => Guard.request(`${Brand.gateway.url}/chat/completions`, { body })).not.toThrow()
    }
    expect(() => Guard.request("https://attacker.example/v1", { body: new TextEncoder().encode("{}") })).not.toThrow()
  })
})
