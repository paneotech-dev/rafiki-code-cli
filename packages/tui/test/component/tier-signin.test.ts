// A key approved without Rafiki Max: the model dialog offers to sign in again
// on the spot, then reloads the configuration and retries the switch. The
// sign-in, the reload and the gateway's answers are stubs here; the dialog
// records what it would show.
import { afterEach, describe, expect, test } from "bun:test"
import { confirmChoice, markConfirmed, resetConfirmed, sessionKey } from "../../src/component/tier-choice"
import type { DialogContext } from "../../src/ui/dialog"

afterEach(() => resetConfirmed())

const reply = (models: string[]) => ({ ok: true as const, info: { spend: 0, maxBudget: null, models }, at: 0 })

// Answers /key/info from a list, one answer per call, the last one repeated.
function answers(...lists: string[][]) {
  let call = 0
  return async () => reply(lists[Math.min(call++, lists.length - 1)]!)
}

// A dialog that closes everything it is shown at once, so an alert resolves.
function dialog() {
  const shown: number[] = []
  const ctx = {
    replace: (_: unknown, onClose?: () => void) => {
      shown.push(1)
      onClose?.()
    },
    clear: () => {},
  } as unknown as DialogContext
  return { ctx, shown }
}

const base = { providerID: "rafiki", modelID: "rafiki-max", env: {} as Record<string, string | undefined> }

describe("Max missing on the key", () => {
  test("signing in again replaces the key, reloads and retries the switch", async () => {
    const key = sessionKey("ses_signin")
    markConfirmed(key)
    const d = dialog()
    const steps: string[] = []
    const ok = await confirmChoice({
      ...base,
      dialog: d.ctx,
      key,
      read: answers(["rafiki-fast", "rafiki-pro"], ["rafiki-fast", "rafiki-pro", "rafiki-max"]),
      signIn: async (model) => {
        steps.push(`signin ${model}`)
        return true
      },
      reload: async () => {
        steps.push("reload")
      },
    })
    expect(ok).toBe(true)
    expect(steps).toEqual(["signin rafiki-max", "reload"])
    // Nothing else was shown: no alert, and the session had confirmed Max already.
    expect(d.shown).toHaveLength(0)
  })

  test("declining the sign-in leaves the model as it was", async () => {
    const d = dialog()
    let reloaded = false
    const ok = await confirmChoice({
      ...base,
      dialog: d.ctx,
      key: sessionKey("ses_decline"),
      read: answers(["rafiki-fast"]),
      signIn: async () => false,
      reload: async () => {
        reloaded = true
      },
    })
    expect(ok).toBe(false)
    expect(reloaded).toBe(false)
  })

  test("a new key still without Max says so instead of switching", async () => {
    const key = sessionKey("ses_still")
    markConfirmed(key)
    const d = dialog()
    const ok = await confirmChoice({
      ...base,
      dialog: d.ctx,
      key,
      read: answers(["rafiki-fast"]),
      signIn: async () => true,
      reload: async () => {},
    })
    expect(ok).toBe(false)
    expect(d.shown).toHaveLength(1)
  })

  test("a server key from the environment is not replaced by a sign-in", async () => {
    const d = dialog()
    let asked = false
    const ok = await confirmChoice({
      ...base,
      env: { RAFIKICODE_API_KEY: "sk-server" },
      dialog: d.ctx,
      key: sessionKey("ses_env"),
      read: answers(["rafiki-fast"]),
      signIn: async () => {
        asked = true
        return true
      },
    })
    expect(ok).toBe(false)
    expect(asked).toBe(false)
    expect(d.shown).toHaveLength(1)
  })

  test("a key that includes Max goes straight on", async () => {
    const key = sessionKey("ses_has")
    markConfirmed(key)
    let asked = false
    const ok = await confirmChoice({
      ...base,
      dialog: dialog().ctx,
      key,
      read: answers(["rafiki-fast", "rafiki-max"]),
      signIn: async () => {
        asked = true
        return true
      },
    })
    expect(ok).toBe(true)
    expect(asked).toBe(false)
  })
})
