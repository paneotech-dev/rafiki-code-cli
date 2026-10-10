// rafikicode run --model rafiki/rafiki-max: the price is said once on
// standard error, and a key approved without the tier is caught before the
// first request, from the gateway's own answer about the key (GET /key/info),
// with what to do about it. When the gateway cannot be asked, the run goes
// ahead and the gateway's refusal, if any, is reported as usual.
import * as Account from "@opencode-ai/core/brand/account"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Tier from "@opencode-ai/core/brand/tier"
import * as Contract from "./contract"

export const exitCode = Contract.EXIT.usage

function tierOf(model: string | undefined) {
  if (!model) return undefined
  const [provider, ...rest] = model.split("/")
  const id = rest.join("/")
  return provider === Brand.provider.id && Tier.needsConfirm(provider, id) ? id : undefined
}

// The message to stop with, or undefined to go ahead.
export async function refusal(
  model: string | undefined,
  read: () => Promise<Account.KeyInfoResult> = () => Account.keyInfo({ timeoutMs: 4_000 }),
): Promise<string | undefined> {
  const id = tierOf(model)
  if (!id) return undefined
  const result = await read().catch((): Account.KeyInfoResult => ({ ok: false, at: Date.now() }))
  if (!result.ok) return undefined
  return Tier.allows(result.info.models, id) === false ? Tier.notOnKeyMessage(id) : undefined
}

// "Rafiki Max uses 15x credits." for a run on that tier.
export function note(model: string | undefined) {
  const id = tierOf(model)
  return id ? `${Tier.label(id)} uses ${Tier.credits(id)}.` : undefined
}
