// /github: put the project of this folder on GitHub as a private repository,
// one confirmed step at a time (core/brand/github-setup.ts). Each question is
// a dialog that also shows what was done so far; the last one shows the
// repository's address and the next steps, or what to fix and why it stopped.
// git and gh run in this folder with the person's own sign-in.
import { Brand } from "@opencode-ai/core/brand/brand"
import * as GithubSetup from "@opencode-ai/core/brand/github-setup"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "./builtins"

const id = "internal:rafiki-github"
export const COMMAND = "github.setup"
const GUIDE = `${Brand.docs}/blob/main/docs/github.md#deploy-to-a-server`
const TITLE = "GitHub"
// Lines of progress shown above a question.
const RECENT = 6

export function dialogIo(api: TuiPluginApi, log: string[], overrides: Partial<GithubSetup.Io> = {}): GithubSetup.Io {
  const context = (question: string) => [...log.slice(-RECENT), ...(log.length ? [""] : []), question].join("\n")
  return {
    ...GithubSetup.defaults(),
    cwd: api.state.path.directory,
    guide: GUIDE,
    say(text) {
      log.push(text)
    },
    confirm(question) {
      return new Promise<boolean>((resolve) => {
        let settled = false
        const settle = (value: boolean) => {
          if (settled) return
          settled = true
          resolve(value)
        }
        api.ui.dialog.replace(
          () => (
            <api.ui.DialogConfirm
              title={TITLE}
              message={context(question)}
              onConfirm={() => settle(true)}
              onCancel={() => settle(false)}
            />
          ),
          () => settle(false),
        )
      })
    },
    ask(question, suggested) {
      return new Promise<string | undefined>((resolve) => {
        let settled = false
        const settle = (value: string | undefined) => {
          if (settled) return
          settled = true
          resolve(value)
        }
        api.ui.dialog.replace(
          () => (
            <api.ui.DialogPrompt
              title={`${TITLE}: ${question}`}
              value={suggested}
              onConfirm={(value) => {
                settle(value.trim() || suggested)
                api.ui.dialog.clear()
              }}
              onCancel={() => {
                settle(undefined)
                api.ui.dialog.clear()
              }}
            />
          ),
          () => settle(undefined),
        )
      })
    },
    ...overrides,
  }
}

let running = false

export async function start(api: TuiPluginApi, overrides: Partial<GithubSetup.Io> = {}) {
  if (running) return
  running = true
  const log: string[] = []
  api.ui.toast({ variant: "info", message: "GitHub: checking git and gh" })
  try {
    const outcome = await GithubSetup.run(dialogIo(api, log, overrides)).catch(
      (error): GithubSetup.Outcome => ({ status: "stopped", message: error instanceof Error ? error.message : String(error) }),
    )
    const message = [...log, ...(log.length ? [""] : []), outcome.message].join("\n")
    const title = outcome.status === "done" ? `${TITLE}: done` : outcome.status === "cancelled" ? `${TITLE}: stopped` : `${TITLE}: needs attention`
    api.ui.dialog.replace(() => <api.ui.DialogAlert title={title} message={message} />)
    return outcome
  } finally {
    running = false
  }
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: COMMAND,
        title: "GitHub: put this project on GitHub",
        category: "Project",
        namespace: "palette",
        slashName: "github",
        run() {
          void start(api)
        },
      },
    ],
    bindings: [],
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
