// The messages for a session that cannot reach a Rafiki model: no key and no
// sign in, or a model outside the provider scope (Brand.providers). The
// server otherwise only answers "Unexpected server error". The same wording
// is used by rafikicode run, the terminal interface and rafikicode acp.
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Contract from "./contract"

// True when this process has no usable Rafiki key: no env key and no stored
// sign in, or a stored browser sign in that CI refuses.
export function missing() {
  return !Brand.hasKey() || Brand.sessionKeyRefusedInCI()
}

export function noKey() {
  const url = Brand.consoleURL()
  return [
    `${Brand.product} needs a Rafiki AI account. Create one in the Rafiki AI console (${url}), then run: ${Brand.name} login`,
    `On a server or in CI, create an API key at ${url}${Contract.PATH.keysPage} with the Rafiki Code option ticked, and set ${Brand.env.apiKey}.`,
  ].join("\n")
}

export function outOfScope() {
  return `${Brand.name} runs on ${Brand.provider.name} models only (${Brand.provider.offered().join(", ")}). Run ${Brand.name} models to see them.`
}

function rafikiModel(model: string | undefined) {
  return !model || model.startsWith(`${Brand.provider.id}/`)
}

// The message for a failed run, or undefined when the failure has its own.
// With the provider scope on, every model needs a Rafiki key and any other
// provider's model is out of scope. With the escape hatch on, only a rafiki
// model run without a key gets the no key message.
export function message(model: string | undefined) {
  if (Brand.providers.open()) return rafikiModel(model) && missing() ? noKey() : undefined
  if (missing()) return noKey()
  if (!rafikiModel(model)) return outOfScope()
  return undefined
}

// Commands that start a local session and so need a key before anything
// else: the terminal interface (no command) and run, unless it attaches to
// a server that has its own. rafikicode acp starts regardless, so an editor
// can offer its sign in action; its sessions answer auth_required instead.
export function needed(command: unknown, attach: unknown) {
  if (Brand.providers.open()) return false
  if (command === undefined) return true
  return command === "run" && !attach
}

export const exitCode = Contract.EXIT.usage
