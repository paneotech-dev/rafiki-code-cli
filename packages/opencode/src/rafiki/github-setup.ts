/**
 * `rafikicode github`: the guided GitHub setup of core/brand/github-setup.ts
 * on the command line. In a terminal each step asks for a yes; without one
 * (a script, CI) it needs --yes, which answers yes to every step, and takes
 * the repository name from --name or the folder.
 */
import { Brand } from "@opencode-ai/core/brand/brand"
import * as GithubSetup from "@opencode-ai/core/brand/github-setup"
import path from "path"
import readline from "readline"
import { cmd } from "@/cli/cmd/cmd"
import * as Contract from "./contract"

export const GUIDE = `${Brand.docs}/blob/main/docs/github.md#deploy-to-a-server`

function prompt(question: string): Promise<string | undefined> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve) => {
    let answered = false
    rl.on("close", () => {
      if (!answered) resolve(undefined)
    })
    rl.question(question, (answer) => {
      answered = true
      rl.close()
      resolve(answer)
    })
  })
}

export function terminalIo(input: { cwd: string; yes: boolean; name?: string; interactive: boolean }): GithubSetup.Io {
  const base = GithubSetup.defaults()
  return {
    ...base,
    cwd: input.cwd,
    guide: GUIDE,
    say(text) {
      process.stdout.write(text + "\n")
    },
    async confirm(question) {
      if (input.yes) {
        process.stdout.write(`${question} yes (--yes)\n`)
        return true
      }
      if (!input.interactive) {
        process.stdout.write(`${question}\nNo terminal to answer in: rerun with --yes to accept every step.\n`)
        return false
      }
      const answer = await prompt(`${question} [y/N] `)
      return /^y(es)?$/i.test((answer ?? "").trim())
    },
    async ask(question, suggested) {
      const value = input.name ?? suggested
      if (input.yes || !input.interactive) {
        process.stdout.write(`${question}: ${value}\n`)
        return value
      }
      const answer = await prompt(`${question} [${value}]: `)
      if (answer === undefined) return undefined
      return answer.trim() || value
    },
  }
}

export const GithubCommand = cmd({
  command: "github",
  describe: "put this project on GitHub as a private repository, step by step",
  builder: (yargs) =>
    yargs
      .option("yes", { alias: ["y"], type: "boolean", default: false, describe: "answer yes to every step (needed without a terminal)" })
      .option("name", { type: "string", describe: "name of the new repository (default: the folder name)" })
      .option("dir", { type: "string", describe: "the project folder (default: the current folder)" }),
  async handler(args) {
    const cwd = path.resolve(args.dir ?? process.cwd())
    const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY)
    if (args.name !== undefined && !GithubSetup.validName(args.name)) {
      process.stderr.write("--name: a repository name uses letters, digits, '.', '-' and '_' only, up to 100 characters.\n")
      process.exitCode = Contract.EXIT.usage
      return
    }
    const outcome = await GithubSetup.run(terminalIo({ cwd, yes: args.yes, name: args.name, interactive }))
    if (outcome.status === "done") {
      process.stdout.write(outcome.message + "\n")
      return
    }
    process.stderr.write(outcome.message + "\n")
    process.exitCode = Contract.EXIT.failed
  },
})
