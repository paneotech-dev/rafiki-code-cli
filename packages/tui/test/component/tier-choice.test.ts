// Choosing Rafiki Max in the terminal interface: the key check from
// /key/info and the switch shortcuts may make without asking.
import { afterEach, describe, expect, test } from "bun:test"
import { keyAllows, markConfirmed, resetConfirmed, sessionKey, silentSwitchAllowed } from "../../src/component/tier-choice"

afterEach(() => resetConfirmed())

const max = { providerID: "rafiki", modelID: "rafiki-max" }
const fast = { providerID: "rafiki", modelID: "rafiki-fast" }

describe("switching without asking", () => {
  test("any tier but max, and max once the session confirmed it", () => {
    expect(silentSwitchAllowed(fast, sessionKey("ses_1"))).toBe(true)
    expect(silentSwitchAllowed(max, sessionKey("ses_1"))).toBe(false)
    markConfirmed(sessionKey("ses_1"))
    expect(silentSwitchAllowed(max, sessionKey("ses_1"))).toBe(true)
    expect(silentSwitchAllowed(max, sessionKey("ses_2"))).toBe(false)
    expect(sessionKey(undefined)).toBe("new")
  })
})

describe("the key check", () => {
  test("denied only when the gateway's list leaves max out", async () => {
    const reply = (models: string[]) => async () => ({ ok: true as const, info: { spend: 0, maxBudget: null, models }, at: 0 })
    expect(await keyAllows("rafiki-max", reply(["rafiki-fast"]))).toBe("denied")
    expect(await keyAllows("rafiki-max", reply(["rafiki-fast", "rafiki-max"]))).toBe("allowed")
    expect(await keyAllows("rafiki-max", reply([]))).toBe("allowed")
    expect(await keyAllows("rafiki-max", async () => ({ ok: false as const, status: 401, at: 0 }))).toBe("allowed")
    expect(await keyAllows("rafiki-max", async () => Promise.reject(new Error("offline")))).toBe("allowed")
  })
})
