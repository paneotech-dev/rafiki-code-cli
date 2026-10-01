export * as ConfigParse from "./parse"

import { type ParseError as JsoncParseError, parse as parseJsoncImpl, printParseErrorCode } from "jsonc-parser"
import { Cause, Exit, Schema as EffectSchema, SchemaIssue } from "effect"
import type { DeepMutable } from "@opencode-ai/core/schema"
import { InvalidError, JsonError } from "@opencode-ai/core/v1/config/error"

export function jsonc(text: string, filepath: string): unknown {
  const errors: JsoncParseError[] = []
  const data = parseJsoncImpl(text, errors, { allowTrailingComma: true })
  if (errors.length) {
    const lines = text.split("\n")
    const issues = errors
      .map((e) => {
        const beforeOffset = text.substring(0, e.offset).split("\n")
        const line = beforeOffset.length
        const column = beforeOffset[beforeOffset.length - 1].length + 1
        const problemLine = lines[line - 1]

        const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
        if (!problemLine) return error

        return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
      })
      .join("\n")
    throw new JsonError({
      path: filepath,
      message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${issues}\n--- End ---`,
    })
  }

  return data
}

export function schema<S extends EffectSchema.Decoder<unknown, never>>(
  schema: S,
  data: unknown,
  source: string,
): DeepMutable<S["Type"]> {
  const decoded = EffectSchema.decodeUnknownExit(schema)(data, {
    errors: "all",
    onExcessProperty: "ignore",
    propertyOrder: "original",
  })
  if (Exit.isSuccess(decoded)) return decoded.value as DeepMutable<S["Type"]>
  const error = Cause.squash(decoded.cause)

  throw new InvalidError(
    {
      path: source,
      issues: EffectSchema.isSchemaError(error)
        ? SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map((issue) => ({
            ...issue,
            message: issue.message,
            path: issue.path?.map(String) ?? [],
          }))
        : [{ message: String(error), path: [] }],
    },
    { cause: error },
  )
}

// Legacy terminal interface keys a config file may still carry. They belong to
// the TUI config, not this one, and the loader drops them before decoding.
// Lives here, beside the decoder, so anything that validates a config file
// without loading it (rafikicode doctor) normalizes it the same way.
export function normalizeLoaded(data: unknown): unknown {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return data
  const copy = { ...(data as Record<string, unknown>) }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  return copy
}

// The issue list of a ConfigInvalidError as plain "<message> at <path>" strings,
// or undefined when the error is something else.
export function issuesOf(cause: unknown): string[] | undefined {
  if (cause === null || typeof cause !== "object") return undefined
  const data =
    "data" in cause && cause.data && typeof cause.data === "object"
      ? (cause.data as Record<string, unknown>)
      : (cause as Record<string, unknown>)
  const issues = Array.isArray(data.issues) ? data.issues : []
  const listed = issues.flatMap((issue) => {
    if (!issue || typeof issue !== "object") return []
    const record = issue as Record<string, unknown>
    if (typeof record.message !== "string") return []
    const where = Array.isArray(record.path)
      ? record.path.filter((p): p is string => typeof p === "string").join(".")
      : ""
    return [where ? `${record.message} at ${where}` : record.message]
  })
  if (listed.length) return listed
  const message = typeof data.message === "string" ? data.message : undefined
  return message ? [message] : undefined
}
