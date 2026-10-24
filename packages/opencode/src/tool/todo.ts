import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"
import { keepCriteria } from "@/rafiki/review"

export const Parameters = Schema.Struct({
  todos: Schema.mutable(Schema.Array(Todo.Info)).annotate({ description: "The updated todo list" }),
})

type Metadata = {
  todos: Todo.Info[]
}

export const TodoWriteTool = Tool.define<typeof Parameters, Metadata, Todo.Service>(
  "todowrite",
  Effect.gen(function* () {
    const todo = yield* Todo.Service

    return {
      description: DESCRIPTION_WRITE,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "todowrite",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          // The acceptance criteria of the task stay in the list (rafiki/review.ts).
          const todos = keepCriteria(yield* todo.get(ctx.sessionID), params.todos)
          yield* todo.update({
            sessionID: ctx.sessionID,
            todos,
          })

          return {
            title: `${todos.filter((x) => x.status !== "completed").length} todos`,
            output: JSON.stringify(todos, null, 2),
            metadata: {
              todos,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
