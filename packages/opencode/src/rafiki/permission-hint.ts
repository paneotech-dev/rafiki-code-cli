// One line printed after `rafikicode run` rejects a permission question nobody
// can answer, so the user learns how to allow it instead of only seeing the
// task stop. Printed once per permission kind per run.
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Trust from "@opencode-ai/core/brand/trust"

const shown = new Set<string>()

export function reset() {
  shown.clear()
}

export function rejectHint(permission: string) {
  if (shown.has(permission)) return undefined
  shown.add(permission)
  const why = Trust.ci() ? "this CI run cannot ask for approval" : "this run cannot ask for approval"
  const example = JSON.stringify({ permission: { [permission]: "allow" } })
  return `Hint: ${permission} was rejected because ${why}. Rerun with ${Brand.name} run --auto, or allow it in ${Brand.configHint}, for example ${example}.`
}
