export * as ConfigPermissionV1 from "./permission"

import { Schema, SchemaGetter } from "effect"

export const Action = Schema.Literals(["ask", "allow", "deny"]).annotate({ identifier: "PermissionActionConfig" })
export type Action = Schema.Schema.Type<typeof Action>

export const Object = Schema.Record(Schema.String, Action).annotate({ identifier: "PermissionObjectConfig" })
export type Object = Schema.Schema.Type<typeof Object>

export const Rule = Schema.Union([Action, Object]).annotate({ identifier: "PermissionRuleConfig" })
export type Rule = Schema.Schema.Type<typeof Rule>

export const Mode = Schema.Literals(["ask", "auto", "plan"]).annotate({
  identifier: "PermissionModeConfig",
  description:
    "The permission mode used when none was picked in the interface: ask (the rules decide), auto (only guarded actions ask) or plan (read-only).",
})
export type Mode = Schema.Schema.Type<typeof Mode>

// Every value a key of the permission object may hold: a rule, or one of the
// two settings below. Which key may hold which is checked by `settings`.
const Value = Schema.Union([Rule, Mode, Schema.Boolean])

// "mode" and "auto_check" are settings, not rules; any other key is a rule.
const settings = Schema.makeFilter((input: Record<string, unknown>) => {
  for (const [key, value] of globalThis.Object.entries(input)) {
    if (key === "mode") {
      if (!["ask", "auto", "plan"].includes(value as string)) return `permission.mode must be "ask", "auto" or "plan"`
      continue
    }
    if (key === "auto_check") {
      if (typeof value !== "boolean") return "permission.auto_check must be true or false"
      continue
    }
    if (typeof value === "boolean" || value === "auto" || value === "plan") {
      return `permission.${key} must be "ask", "allow", "deny" or an object of patterns`
    }
  }
  return undefined
})

// Known permission keys get explicit types in the Effect schema for generated
// docs/types. Runtime config parsing uses Effect's `propertyOrder: "original"`
// parse option so user key order is preserved for permission precedence.
const InputObject = Schema.StructWithRest(
  Schema.Struct({
    mode: Schema.optional(Mode),
    auto_check: Schema.optional(Schema.Boolean).annotate({
      description: "In auto mode, a short risk check on the rafiki-fast tier for shell commands the rules cannot classify (default true).",
    }),
    read: Schema.optional(Rule),
    edit: Schema.optional(Rule),
    glob: Schema.optional(Rule),
    grep: Schema.optional(Rule),
    list: Schema.optional(Rule),
    bash: Schema.optional(Rule),
    task: Schema.optional(Rule),
    external_directory: Schema.optional(Rule),
    todowrite: Schema.optional(Action),
    question: Schema.optional(Action),
    webfetch: Schema.optional(Action),
    websearch: Schema.optional(Action),
    lsp: Schema.optional(Rule),
    doom_loop: Schema.optional(Action),
    skill: Schema.optional(Rule),
  }),
  [Schema.Record(Schema.String, Value)],
).check(settings)

const InputSchema = Schema.Union([Action, InputObject])

const normalizeInput = (input: Schema.Schema.Type<typeof InputSchema>): Schema.Schema.Type<typeof InputObject> =>
  typeof input === "string" ? { "*": input } : input

export const Info = InputSchema.pipe(
  Schema.decodeTo(InputObject, {
    decode: SchemaGetter.transform(normalizeInput),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
).annotate({ identifier: "PermissionConfig" })
type _Info = Schema.Schema.Type<typeof InputObject>
export type Info = { -readonly [K in keyof _Info]: _Info[K] }
