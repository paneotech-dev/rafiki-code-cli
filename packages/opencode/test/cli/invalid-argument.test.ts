// A rejected argument has to say what was rejected.
//
// The `.fail` handler in src/index.ts printed help and exited 1 without ever
// writing yargs' message, so every one of these cases gave the user a wall of
// options and no stated reason. `upgrade --method npm` is the one that made it
// visible, at a time when npm was not an upgrade method and nothing on screen
// said so. npm is a method now, so these cases use a value that never will be
// one: a test must not hand the command a method it would then carry out.
//
// These assert the reason reaches stderr, that help is still printed with it,
// and that the exit code is unchanged.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

describe("invalid arguments explain themselves", () => {
  cliIt.live(
    "a rejected --method names the argument, the value and the allowed values",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["upgrade", "--method", "apt"], { env: { COLUMNS: "120" } })

        expect(result.exitCode).toBe(1)
        // The reason.
        expect(result.stderr).toContain("Invalid values:")
        expect(result.stderr).toContain("method")
        expect(result.stderr).toContain('"apt"')
        // What it should have been: the choices are stated, not implied.
        expect(result.stderr).toContain('"curl"')
        expect(result.stderr).toContain('"npm"')
        // Help still comes with it.
        expect(result.stderr).toContain("--method")
      }),
    { timeout: 60_000 },
  )

  cliIt.live(
    "an unknown flag names itself",
    ({ opencode }) =>
      Effect.gen(function* () {
        // Not `--no-bogus-flag`: yargs reads a leading `no-` as its negation
        // prefix and strips it, so the reported name would not be the one
        // that was typed.
        const result = yield* opencode.spawn(["upgrade", "--bogus-flag"], { env: { COLUMNS: "120" } })

        expect(result.exitCode).toBe(1)
        // yargs pluralizes when it has more than one, and reports both the
        // dashed and camelCase spellings, so match the stem only.
        expect(result.stderr).toContain("Unknown argument")
        expect(result.stderr).toContain("bogus-flag")
      }),
    { timeout: 60_000 },
  )

  cliIt.live(
    "the reason is the last thing printed, not scrolled away by the help",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["upgrade", "--method", "apt"], { env: { COLUMNS: "120" } })

        const reason = result.stderr.indexOf("Invalid values:")
        const help = result.stderr.indexOf("installation method to use")
        expect(reason).toBeGreaterThan(-1)
        expect(help).toBeGreaterThan(-1)
        expect(reason).toBeGreaterThan(help)
      }),
    { timeout: 60_000 },
  )

  cliIt.live(
    "a valid command is unaffected",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["upgrade", "--help"], { env: { COLUMNS: "120" } })

        expect(result.exitCode).toBe(0)
        expect(result.stderr).not.toContain("Invalid values:")
        expect(result.stderr).not.toContain("Unknown argument")
      }),
    { timeout: 60_000 },
  )
})
