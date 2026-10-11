// Signing in again for Rafiki Max without leaving the interface: the sign-in
// the dialog runs (core/brand/device-flow.ts signIn) against the mock Console,
// with the keys it delivers registered on the mock gateway, whose /key/info
// answer is what the interface checks before and after.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import * as Account from "@opencode-ai/core/brand/account"
import * as Credentials from "@opencode-ai/core/brand/credentials"
import * as Tier from "@opencode-ai/core/brand/tier"
import * as DeviceFlow from "@/rafiki/device-flow"
import * as Contract from "@/rafiki/contract"
import { createMockConsole } from "../brand/mock-console.mjs"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

let clock = 1_700_000_000_000

async function setup() {
  const gateway = createMockGateway({ quiet: true })
  await gateway.ready
  const console_ = createMockConsole({ quiet: true, interval: 1, now: () => clock, gatewayURL: gateway.url + "/v1" })
  await console_.ready
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-tier-signin-"))
  cleanup.push(
    async () => {
      await gateway.close()
    },
    async () => {
      await console_.close()
    },
    () => fs.rmSync(dir, { recursive: true, force: true }),
  )
  const bodies: any[] = []
  const client = DeviceFlow.client({
    consoleURL: console_.url,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    fetch: async (input, init) => {
      if (typeof init?.body === "string" && input.endsWith(Contract.PATH.deviceCode)) bodies.push(JSON.parse(init.body))
      return fetch(input, init)
    },
  })
  return { gateway, console_, dir, client, bodies }
}

// The Console grants what was ticked; the gateway is told the same models.
async function signIn(
  env: Awaited<ReturnType<typeof setup>>,
  tiers: string[] | undefined,
  previous?: Credentials.StoredCredential,
) {
  const shown: string[] = []
  const result = await DeviceFlow.signIn({
    client: env.client,
    label: "rafikicode test",
    dir: env.dir,
    previous,
    events: {
      onCode: (code) => shown.push(code.user_code, code.verification_uri),
      onPending: () => {
        if (shown[0]) env.console_.approve(shown[0], tiers)
      },
    },
  })
  const granted = (tiers ?? [...Contract.TIERS]).map((tier) => `rafiki-${tier}`)
  await fetch(env.gateway.url + "/__test/register", {
    method: "POST",
    body: JSON.stringify({ key: result.credential.key, key_alias: result.credential.key_alias, models: granted }),
  })
  return { ...result, shown }
}

async function allows(env: Awaited<ReturnType<typeof setup>>, key: string) {
  const result = await Account.keyInfo({ source: { key, gatewayURL: env.gateway.url + "/v1" } })
  return result.ok ? Tier.allows(result.info.models, "rafiki-max") : undefined
}

describe("signing in again for Max", () => {
  test("the requested tiers include max", async () => {
    expect(Contract.TIERS).toContain("max")
    const env = await setup()
    await signIn(env, undefined)
    expect(env.bodies[0].requested_tiers).toEqual(["fast", "pro", "max"])
  })

  test("a key without max is replaced by one with it, and the old key is revoked", async () => {
    const env = await setup()
    const first = await signIn(env, ["fast", "pro"])
    expect(await allows(env, first.credential.key)).toBe(false)
    expect(Tier.notOnKeyMessage("rafiki-max")).toMatch(/: rafikicode login$/)

    const second = await signIn(env, undefined, first.credential)
    // The code and the address were handed over to be shown.
    expect(second.shown[0]).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
    expect(second.shown[1]).toBe(`${env.console_.url}/device`)
    // Stored in place of the old key, which the Console has revoked.
    expect(Credentials.read(env.dir)?.key).toBe(second.credential.key)
    expect(second.credential.key).not.toBe(first.credential.key)
    expect(second.revokedPrevious).toBe(true)
    expect(await allows(env, second.credential.key)).toBe(true)
  })

  test("a refused sign-in keeps the stored key", async () => {
    const env = await setup()
    const first = await signIn(env, ["fast"])
    const shown: string[] = []
    const err = await DeviceFlow.signIn({
      client: env.client,
      label: "rafikicode test",
      dir: env.dir,
      previous: first.credential,
      events: {
        onCode: (code) => shown.push(code.user_code),
        onPending: () => {
          if (shown[0]) env.console_.deny(shown[0])
        },
      },
    }).catch((e) => e)
    expect(err).toBeInstanceOf(DeviceFlow.DeviceFlowError)
    expect(Credentials.read(env.dir)?.key).toBe(first.credential.key)
  })
})
