// What `rafikicode run` prints when it rejects a permission question nobody can
// answer: one hint line per permission kind, so the user learns how to allow
// it, and, when every tool call of the run was rejected, a failure instead of
// exit code 0, since nothing was done.
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Trust from "@opencode-ai/core/brand/trust"
import * as Contract from "./contract"

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

// Counts one run's rejected questions and completed tool calls.
export function tracker() {
  let rejected = 0
  let completed = 0
  return {
    rejected(permission: string) {
      rejected++
      return rejectHint(permission)
    },
    completed() {
      completed++
    },
    // The failure to report when tools were asked for and none ran.
    outcome() {
      if (rejected === 0 || completed > 0) return undefined
      return {
        exitCode: Contract.EXIT.failed,
        message: `Every tool call in this run was rejected, so nothing was changed. Rerun with ${Brand.name} run --auto, or allow the tools in ${Brand.configHint}.`,
      }
    },
  }
}
