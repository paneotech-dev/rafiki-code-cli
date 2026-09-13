import { Brand } from "@opencode-ai/core/brand/brand"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import * as BrandServe from "@opencode-ai/core/brand/serve"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: `starts a headless ${Brand.name} server`,
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const opts = yield* resolveNetworkOptions(args)
    if (BrandServe.refused(opts)) return
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`${Brand.name} server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
  }),
})
