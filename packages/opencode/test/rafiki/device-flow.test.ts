// Device flow client against the mock Console, one test per contract outcome.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createMockConsole } from "../brand/mock-console.mjs"
import * as DeviceFlow from "@/rafiki/device-flow"
import * as Contract from "@/rafiki/contract"

type Mock = ReturnType<typeof createMockConsole>
let mock: Mock | undefined

afterEach(async () => {
  await mock?.close()
  mock = undefined
})

// One fake clock shared by the mock and the client, so polling is
// deterministic and no test waits for real seconds.
let clock = 1_700_000_000_000

async function start(options: Record<string, unknown> = {}) {
  clock = 1_700_000_000_000
  mock = createMockConsole({ quiet: true, interval: 1, now: () => clock, ...options })
  await mock.ready
  return mock
}

// A client whose sleeps advance the fake clock instead of waiting.
function fastClient(url: string) {
  const sleeps: number[] = []
  const c = DeviceFlow.client({
    consoleURL: url,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
  })
  return { c, sleeps }
}

describe("requestCode", () => {
  test("returns the contract fields and defaults", async () => {
    const m = await start()
    const { c } = fastClient(m.url)
    const code = await DeviceFlow.requestCode(c, { label: "rafikicode test on box" })
    expect(code.device_code).toHaveLength(43)
    expect(code.user_code).toMatch(/^[BCDFGHJKMNPQRSTVWXZ]{4}-[BCDFGHJKMNPQRSTVWXZ]{4}$/)
    expect(code.verification_uri).toBe(`${m.url}/device`)
    expect(code.verification_uri_complete).toContain("/device?code=")
    expect(code.interval).toBe(1)
    expect(code.expires_in).toBe(600)
    expect(m.requests[0]).toMatchObject({ path: Contract.PATH.deviceCode, client_id: Contract.CLIENT_ID, surface: "cli" })
  })

  test("network failure is exit code 4", async () => {
    const { c } = fastClient("http://127.0.0.1:1")
    const err = await DeviceFlow.requestCode(c, { label: "x" }).catch((e) => e)
    expect(err).toBeInstanceOf(DeviceFlow.DeviceFlowError)
    expect(err.code).toBe("network")
    expect(err.exitCode).toBe(Contract.EXIT.network)
  })
})

describe("pollToken", () => {
  test("pending then approved delivers the key once", async () => {
    const m = await start()
    const { c, sleeps } = fastClient(m.url)
    const code = await DeviceFlow.requestCode(c, { label: "x" })
    let pending = 0
    const polling = DeviceFlow.pollToken(c, code, { onPending: () => pending++ })
    // Approve from "the browser" after the first pending poll.
    while (pending < 1) await new Promise((r) => setTimeout(r, 10))
    expect(m.approve(code.user_code)).toBe(true)
    const token = await polling
    expect(token.access_token).toStartWith("sk-mock-")
    expect(token.key_alias).toStartWith("rafikicode-")
    expect(token.gateway_url).toBe("https://gateway.rafikiai.io/v1")
    expect(token.owner?.email).toBe("jane@example.com")
    expect(sleeps.every((ms) => ms === 1000)).toBe(true)
    // The code is consumed: a second poll is expired_token.
    const again = await DeviceFlow.pollToken(c, code).catch((e) => e)
    expect(again.code).toBe(Contract.ERROR.expiredToken)
    expect(again.exitCode).toBe(Contract.EXIT.usage)
  })

  test("slow_down adds the increment to the interval", async () => {
    const m = await start({ slowDownOnce: true, auto: "approve", autoAfter: 2 })
    const { c, sleeps } = fastClient(m.url)
    const code = await DeviceFlow.requestCode(c, { label: "x" })
    const seen: number[] = []
    const token = await DeviceFlow.pollToken(c, code, { onSlowDown: ({ interval }) => seen.push(interval) })
    expect(token.access_token).toBeDefined()
    expect(seen).toEqual([1 + Contract.SLOW_DOWN_INCREMENT])
    expect(sleeps).toEqual([1000, (1 + Contract.SLOW_DOWN_INCREMENT) * 1000])
  })

  test("polling sooner than the interval is refused by the server with slow_down", async () => {
    const m = await start({ interval: 5, auto: "approve", autoAfter: 3 })
    // A misbehaving client: its first wait is half the interval, later waits are honest.
    const sleeps: number[] = []
    const c = DeviceFlow.client({
      consoleURL: m.url,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += sleeps.length === 2 ? ms / 2 : ms
      },
    })
    const code = await DeviceFlow.requestCode(c, { label: "x" })
    const seen: number[] = []
    const token = await DeviceFlow.pollToken(c, code, { onSlowDown: ({ interval }) => seen.push(interval) })
    expect(token.access_token).toBeDefined()
    expect(seen).toEqual([10])
    expect(sleeps).toEqual([5000, 5000, 10000])
    const state = [...m.codes.values()][0] as any
    expect(state.acceptedInterval).toBe(10)
  })

  test("access_denied stops with exit code 1", async () => {
    const m = await start({ auto: "deny", autoAfter: 1 })
    const { c } = fastClient(m.url)
    const code = await DeviceFlow.requestCode(c, { label: "x" })
    const err = await DeviceFlow.pollToken(c, code).catch((e) => e)
    expect(err.code).toBe(Contract.ERROR.accessDenied)
    expect(err.exitCode).toBe(Contract.EXIT.failed)
    expect(err.message).toBe("Sign-in was denied in the browser.")
  })

  test("expired_token stops with exit code 2", async () => {
    const m = await start({ auto: "expire", autoAfter: 1 })
    const { c } = fastClient(m.url)
    const code = await DeviceFlow.requestCode(c, { label: "x" })
    const err = await DeviceFlow.pollToken(c, code).catch((e) => e)
    expect(err.code).toBe(Contract.ERROR.expiredToken)
    expect(err.exitCode).toBe(Contract.EXIT.usage)
    expect(err.message).toContain("rafikicode login")
  })

  test("client side deadline stops without a request", async () => {
    const m = await start()
    let now = clock
    const c = DeviceFlow.client({ consoleURL: m.url, sleep: async () => void (now += 700_000), now: () => now })
    const code = await DeviceFlow.requestCode(c, { label: "x" })
    const before = m.requests.length
    const err = await DeviceFlow.pollToken(c, code).catch((e) => e)
    expect(err.code).toBe(Contract.ERROR.expiredToken)
    expect(m.requests.length).toBe(before)
  })

  test("invalid_grant for an unknown device code", async () => {
    const m = await start()
    const { c } = fastClient(m.url)
    const err = await DeviceFlow.pollToken(c, { device_code: "nope", interval: 1, expires_in: 600 }).catch((e) => e)
    expect(err.code).toBe(Contract.ERROR.invalidGrant)
    expect(err.exitCode).toBe(Contract.EXIT.usage)
  })

  test("429 waits Retry-After and resumes", async () => {
    const m = await start({ rateLimitOnce: true, auto: "approve", autoAfter: 2 })
    const { c } = fastClient(m.url)
    const code = await DeviceFlow.requestCode(c, { label: "x" })
    const limited: number[] = []
    const token = await DeviceFlow.pollToken(c, code, { onRateLimited: ({ retryAfter }) => limited.push(retryAfter) })
    expect(token.access_token).toBeDefined()
    expect(limited).toEqual([1])
  })

  test("503 stops with exit code 4", async () => {
    const m = await start({ unavailable: true })
    const { c } = fastClient(m.url)
    const code = await DeviceFlow.requestCode(c, { label: "x" })
    const err = await DeviceFlow.pollToken(c, code).catch((e) => e)
    expect(err.code).toBe(Contract.ERROR.serviceUnavailable)
    expect(err.exitCode).toBe(Contract.EXIT.network)
  })
})

describe("account routes", () => {
  test("me, refresh, and revoke", async () => {
    const m = await start({ auto: "approve", autoAfter: 1 })
    const { c } = fastClient(m.url)
    const code = await DeviceFlow.requestCode(c, { label: "x" })
    const token = await DeviceFlow.pollToken(c, code)
    const me = await DeviceFlow.me(c, token.access_token)
    expect(me.owner.email).toBe("jane@example.com")
    expect(me.key?.alias).toBe(token.key_alias)
    expect(me.wallet?.balance_usd).toBe(12.4)

    const rotated = await DeviceFlow.refresh(c, token.access_token)
    expect(rotated.access_token).not.toBe(token.access_token)
    const stale = await DeviceFlow.me(c, token.access_token).catch((e) => e)
    expect(stale.code).toBe(Contract.ERROR.keyRevoked)
    expect(stale.exitCode).toBe(Contract.EXIT.usage)

    await DeviceFlow.revoke(c, rotated.access_token, rotated.key_id!)
    const gone = await DeviceFlow.me(c, rotated.access_token).catch((e) => e)
    expect(gone.code).toBe(Contract.ERROR.keyRevoked)
    // Revoking again is not an error for logout.
    await DeviceFlow.revoke(c, rotated.access_token, rotated.key_id!)
  })
})

describe("policy helpers", () => {
  test("headless detection", () => {
    expect(DeviceFlow.headless({}, true)).toBeUndefined()
    expect(DeviceFlow.headless({ [Contract.CLIENT_ID.toUpperCase() + "_API_KEY"]: "sk" }, true)).toBe("key")
    expect(DeviceFlow.headless({ CI: "true" }, true)).toBe("ci")
    expect(DeviceFlow.headless({}, false)).toBe("tty")
    expect(DeviceFlow.headless({ RAFIKICODE_TEST_TTY: "1" }, false)).toBeUndefined()
    expect(DeviceFlow.headlessMessage("tty")).toContain("RAFIKICODE_API_KEY")
    expect(DeviceFlow.headlessMessage("ci")).toContain("/keys")
  })

  test("device label", () => {
    expect(DeviceFlow.deviceLabel("0.1.0")).toMatch(/^rafikicode 0\.1\.0 on .+/)
    expect(DeviceFlow.deviceLabel("0.1.0", "my laptop")).toBe("my laptop")
    expect(DeviceFlow.deviceLabel("0.1.0", "x".repeat(300))).toHaveLength(Contract.DEVICE_LABEL_MAX)
  })

  test("refresh policy: within the window, at most hourly, never for keys without expiry", () => {
    const now = Date.parse("2026-09-11T22:00:00Z")
    const base = { version: 1 as const, key: "sk", gateway_url: "g", console_url: "c", created_at: "x" }
    const far = { ...base, expires_at: new Date(now + 20 * 86_400_000).toISOString() }
    const soon = { ...base, expires_at: new Date(now + 3 * 86_400_000).toISOString() }
    expect(DeviceFlow.shouldRefresh(far, now)).toBe(false)
    expect(DeviceFlow.shouldRefresh(far, now, true)).toBe(true)
    expect(DeviceFlow.shouldRefresh(soon, now)).toBe(true)
    expect(DeviceFlow.shouldRefresh({ ...soon, refreshed_at: new Date(now - 600_000).toISOString() }, now)).toBe(false)
    expect(DeviceFlow.shouldRefresh({ ...soon, refreshed_at: new Date(now - 600_000).toISOString() }, now, true)).toBe(false)
    expect(DeviceFlow.shouldRefresh(base, now, true)).toBe(false)
  })

  test("token to credential", () => {
    const now = Date.parse("2026-09-11T22:00:00Z")
    const credential = DeviceFlow.toCredential(
      { access_token: "sk-x", token_type: "bearer", expires_in: 3600, key_id: "k", key_alias: "a", gateway_url: "http://g/v1", console_url: "http://c", owner: { id: "u" } },
      now,
    )
    expect(credential).toMatchObject({ version: 1, key: "sk-x", key_id: "k", key_alias: "a", gateway_url: "http://g/v1", console_url: "http://c" })
    expect(credential.expires_at).toBe("2026-09-11T23:00:00.000Z")
    expect(credential.created_at).toBe("2026-09-11T22:00:00.000Z")
  })
})
