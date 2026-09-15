// The message for a run that failed because no Rafiki key is available: the
// server otherwise only answers "Unexpected server error". Undefined when the
// run named another provider's model or a usable key exists, so every other
// failure keeps its own message.
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Contract from "./contract"

export function message(model: string | undefined) {
  if (model && !model.startsWith(`${Brand.provider.id}/`)) return undefined
  if (Brand.hasKey() && !Brand.sessionKeyRefusedInCI()) return undefined
  return `No ${Brand.provider.name} key found. Set ${Brand.env.apiKey} (create a key at ${Brand.consoleURL()}${Contract.PATH.keysPage}), or run ${Brand.name} login.`
}

export const exitCode = Contract.EXIT.usage
