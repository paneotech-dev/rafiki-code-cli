// Choosing Rafiki Max in the terminal interface. Every tier is offered, with
// its price in credits (core/brand/tier.ts). Before a session moves to Rafiki
// Max the interface asks once, never switching silently, and first asks the
// gateway whether the key in use may call it (/key/info): a key approved
// without the tier is offered a new sign-in on the spot (dialog-tier-signin.tsx),
// after which the configuration is read again and the switch is retried,
// instead of a refusal from the gateway on the next request.
import * as Account from "@opencode-ai/core/brand/account"
import * as Tier from "@opencode-ai/core/brand/tier"
import { Brand } from "@opencode-ai/core/brand/brand"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogConfirm } from "../ui/dialog-confirm"
import type { DialogContext } from "../ui/dialog"
import { isConfirmed, markConfirmed } from "../util/tier-confirmed"

export { isConfirmed, markConfirmed, resetConfirmed, sessionKey } from "../util/tier-confirmed"

// True when a model may be switched to without asking: any model but Rafiki
// Max, or Rafiki Max once this session has confirmed it.
export function silentSwitchAllowed(model: { providerID: string; modelID: string }, key: string) {
  return !Tier.needsConfirm(model.providerID, model.modelID) || isConfirmed(key)
}

// What the gateway says about the key and this model: "denied" when the key's
// models leave it out, "allowed" otherwise (including when the gateway could
// not be asked: the request itself then says what is wrong).
export async function keyAllows(
  modelID: string,
  read: () => Promise<Account.KeyInfoResult> = () => Account.keyInfo({ timeoutMs: 4_000 }),
): Promise<"allowed" | "denied"> {
  const result = await read().catch((): Account.KeyInfoResult => ({ ok: false, at: Date.now() }))
  if (!result.ok) return "allowed"
  return Tier.allows(result.info.models, modelID) === false ? "denied" : "allowed"
}

// Runs the checks for a choice made in the model dialog. Resolves true when
// the model may be set.
export async function confirmChoice(input: {
  dialog: DialogContext
  providerID: string
  modelID: string
  key: string
  read?: () => Promise<Account.KeyInfoResult>
  // Signs in again inside the interface; resolves true once a new key is
  // stored. Without it, the message names the command instead.
  signIn?: (modelID: string) => Promise<boolean>
  // Makes the running server read the new key (configuration and providers).
  reload?: () => Promise<void>
  env?: Record<string, string | undefined>
}): Promise<boolean> {
  if (!Tier.needsConfirm(input.providerID, input.modelID)) return true
  if ((await keyAllows(input.modelID, input.read)) === "denied") {
    const title = `${Tier.label(input.modelID)} is not on this key`
    // A key from the environment is not the stored sign-in, so a new sign-in
    // would not replace it.
    if ((input.env ?? process.env)[Brand.env.apiKey]) {
      await DialogAlert.show(input.dialog, title, Tier.serverKeyMessage(input.modelID))
      return false
    }
    if (!input.signIn) {
      await DialogAlert.show(input.dialog, title, Tier.notOnKeyMessage(input.modelID))
      return false
    }
    if (!(await input.signIn(input.modelID))) return false
    await input.reload?.()
    if ((await keyAllows(input.modelID, input.read)) === "denied") {
      await DialogAlert.show(
        input.dialog,
        title,
        `The new key was approved without ${Tier.label(input.modelID)} too. ${Tier.notOnKeyMessage(input.modelID)}`,
      )
      return false
    }
  }
  if (isConfirmed(input.key)) return true
  const answer = await DialogConfirm.show(input.dialog, Tier.confirmTitle(input.modelID), Tier.confirmMessage(input.modelID))
  if (answer !== true) return false
  markConfirmed(input.key)
  return true
}
