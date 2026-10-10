// memory_update: the one way the agent changes the project memory in
// .rafiki/memory/ (core/brand/memory.ts). One section, one small operation per
// call, so every change is short, structured and easy to review. Refused when
// the text looks like a secret, when the memory would pass its size cap, or
// when the folder leads outside the project.
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import * as RafikiMemory from "@/rafiki/memory"

const { Memory } = RafikiMemory

export const Parameters = Schema.Struct({
  section: Schema.Literals(["project", "decisions", "progress", "notes"]).annotate({
    description:
      "project: what the project is and its stack. decisions: dated decisions with the reason for each. progress: what is done, in progress, next. notes: gotchas and commands that work.",
  }),
  operation: Schema.Literals(["append", "replace", "remove"]).annotate({
    description:
      "append: add one entry. replace: with match, replace the one entry that contains it; without match, rewrite the whole section. remove: remove the one entry that contains text.",
  }),
  text: Schema.String.annotate({
    description:
      "append and replace: the entry (one or two short sentences; for a decision, what was decided and why). remove: a part of the entry to remove.",
  }),
  match: Schema.optional(Schema.String).annotate({
    description: "replace only: a part of the entry to replace. Leave it out to rewrite the whole section with text.",
  }),
})

export const DESCRIPTION = [
  `Records what this project should remember from one session to the next, in ${Memory.DIR_POSIX}/ (project.md, decisions.md, progress.md, notes.md).`,
  "Use it before your final answer when the task settled something worth keeping, and after a compaction for what the summary holds that the memory does not. Do not use it for passing details of the current task.",
  "Entries are short Markdown list items; decisions are dated automatically. Never put secrets in the memory: name the environment variable or file that holds one instead (text that looks like a key or token is refused).",
  `This tool is the only way to change the memory: do not edit files in ${Memory.DIR_POSIX}/ with other tools, and do not commit them; the user decides that.`,
].join("\n")

type Metadata = { section: string; operation: string; file?: string; created?: boolean; total?: number }

export const MemoryUpdateTool = Tool.define<typeof Parameters, Metadata, Config.Service>(
  "memory_update",
  Effect.gen(function* () {
    const config = yield* Config.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          if (!RafikiMemory.enabled(cfg.memory)) {
            return {
              title: "memory off",
              output: "The project memory is turned off for this project; nothing was recorded.",
              metadata: { section: params.section, operation: params.operation },
            }
          }
          const instance = yield* InstanceState.context
          const project = Memory.root(instance.directory, instance.worktree)
          yield* ctx.ask({
            permission: "memory_update",
            patterns: [params.section],
            always: ["*"],
            metadata: { section: params.section, operation: params.operation, text: params.text },
          })
          const outcome = Memory.update(
            project,
            { section: params.section, operation: params.operation, text: params.text, match: params.match },
            { limit: RafikiMemory.limit(cfg.memory) },
          )
          if (!outcome.ok) throw new Error(outcome.message)
          const hint =
            outcome.created && Memory.isGit(project) && !Memory.status(project).items.some((item) => item.file !== Memory.SECTIONS[params.section].file && !item.empty)
              ? ` The memory folder is new: tell the user that ${Memory.DIR_POSIX}/ can be committed with the project (do not commit it yourself).`
              : ""
          return {
            title: `${params.operation} ${Memory.SECTIONS[params.section].file}`,
            output: outcome.message + hint,
            metadata: {
              section: params.section,
              operation: params.operation,
              file: outcome.file,
              created: outcome.created,
              total: outcome.total,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
