// The key in use was approved without a tier (Rafiki Max), and the person
// picked it. Instead of telling them to leave the interface and run the
// sign-in again, this dialog offers to do it here: "Sign in again now" (or
// y) starts the browser sign-in, shows the address and the code, opens the
// browser when it can, and resolves true once the new key is stored. The
// caller (tier-choice.tsx) then reloads the configuration and retries the
// switch.
import { TextAttributes } from "@opentui/core"
import { createStore } from "solid-js/store"
import { For, Match, Switch } from "solid-js"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as DeviceFlow from "@opencode-ai/core/brand/device-flow"
import * as Tier from "@opencode-ai/core/brand/tier"
import { openUrl } from "@opencode-ai/core/open"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import { useBindings } from "../keymap"
import { Link } from "../ui/link"

type Phase =
  | { kind: "offer" }
  | { kind: "starting" }
  | { kind: "code"; url: string; code: string }
  | { kind: "failed"; message: string }

// The sign-in itself, given a way to show the code and to stop. Injected by
// tests; the default is the device flow of core/brand/device-flow.ts, which
// replaces the stored key and revokes the old one.
export type Runner = (input: {
  onCode: (code: { user_code: string; verification_uri: string; verification_uri_complete?: string }) => void
  stopped: () => boolean
}) => Promise<void>

export const STOPPED = "stopped"

export function deviceRunner(): Runner {
  return async (input) => {
    let previous: ReturnType<typeof Brand.credential>
    try {
      previous = Brand.credential()
    } catch {
      previous = undefined
    }
    const base = DeviceFlow.client()
    const client = DeviceFlow.client({
      sleep: async (ms) => {
        // Polled in steps so that closing the dialog stops the sign-in soon.
        const end = base.now() + ms
        while (base.now() < end) {
          if (input.stopped()) throw new Error(STOPPED)
          await base.sleep(Math.min(250, end - base.now()))
        }
        if (input.stopped()) throw new Error(STOPPED)
      },
    })
    await DeviceFlow.signIn({
      client,
      label: DeviceFlow.deviceLabel(InstallationVersion),
      previous,
      events: { onCode: input.onCode },
    })
  }
}

export function DialogTierSignIn(props: {
  model: string
  run: Runner
  onDone: (signedIn: boolean) => void
  stop: () => void
  stopped: () => boolean
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [store, setStore] = createStore<{ phase: Phase; active: "signin" | "cancel" }>({
    phase: { kind: "offer" },
    active: "signin",
  })

  const label = Tier.label(props.model)

  function start() {
    if (store.phase.kind !== "offer" && store.phase.kind !== "failed") return
    setStore("phase", { kind: "starting" })
    props
      .run({
        stopped: props.stopped,
        onCode: (code) => {
          const url = code.verification_uri_complete ?? code.verification_uri
          setStore("phase", { kind: "code", url: code.verification_uri, code: code.user_code })
          openUrl(url).catch(() => {})
        },
      })
      .then(
        () => {
          if (props.stopped()) return
          props.onDone(true)
        },
        (cause) => {
          if (props.stopped()) return
          const message = cause instanceof Error ? cause.message : String(cause)
          setStore("phase", { kind: "failed", message })
        },
      )
  }

  function cancel() {
    props.stop()
    dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      {
        key: "y",
        desc: "Sign in again now",
        group: "Dialog",
        cmd: () => start(),
      },
      {
        key: "n",
        desc: "Not now",
        group: "Dialog",
        cmd: () => {
          if (store.phase.kind === "offer" || store.phase.kind === "failed") cancel()
        },
      },
      {
        key: "return",
        desc: "Confirm dialog selection",
        group: "Dialog",
        cmd: () => {
          if (store.phase.kind !== "offer" && store.phase.kind !== "failed") return
          if (store.active === "signin") start()
          else cancel()
        },
      },
      {
        key: "left",
        desc: "Previous dialog option",
        group: "Dialog",
        cmd: () => setStore("active", store.active === "signin" ? "cancel" : "signin"),
      },
      {
        key: "right",
        desc: "Next dialog option",
        group: "Dialog",
        cmd: () => setStore("active", store.active === "signin" ? "cancel" : "signin"),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {`${label} is not on this key`}
        </text>
        <text fg={theme.textMuted} onMouseUp={cancel}>
          esc
        </text>
      </box>
      <Switch>
        <Match when={store.phase.kind === "offer" || store.phase.kind === "failed"}>
          <box paddingBottom={1} gap={1}>
            <text fg={theme.textMuted}>{Tier.signInAgainMessage(props.model)}</text>
            <Switch>
              <Match when={store.phase.kind === "failed" && store.phase}>
                {(failed) => <text fg={theme.error}>{`The sign-in did not finish: ${failed().message}`}</text>}
              </Match>
            </Switch>
          </box>
          <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
            <For each={["cancel", "signin"] as const}>
              {(key) => (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={key === store.active ? theme.primary : undefined}
                  onMouseUp={() => (key === "signin" ? start() : cancel())}
                >
                  <text fg={key === store.active ? theme.selectedListItemText : theme.textMuted}>
                    {key === "signin" ? "Sign in again now (y)" : "Not now (n)"}
                  </text>
                </box>
              )}
            </For>
          </box>
        </Match>
        <Match when={store.phase.kind === "starting"}>
          <box paddingBottom={1}>
            <text fg={theme.textMuted}>Starting the sign-in...</text>
          </box>
        </Match>
        <Match when={store.phase.kind === "code" && store.phase}>
          {(phase) => (
            <box paddingBottom={1} gap={1}>
              <text fg={theme.textMuted}>Open this address in a browser and enter the code:</text>
              <Link href={phase().url} fg={theme.primary} />
              <text attributes={TextAttributes.BOLD} fg={theme.text}>
                {phase().code}
              </text>
              <text fg={theme.textMuted}>
                {`${label} is ticked on the approval page. Waiting for the approval; esc stops.`}
              </text>
            </box>
          )}
        </Match>
      </Switch>
    </box>
  )
}

// Resolves true once a new key is stored, false when the person declines or
// closes the dialog.
DialogTierSignIn.show = (dialog: DialogContext, model: string, run: Runner = deviceRunner()) => {
  return new Promise<boolean>((resolve) => {
    let stopped = false
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    dialog.replace(
      () => (
        <DialogTierSignIn
          model={model}
          run={run}
          stopped={() => stopped}
          stop={() => {
            stopped = true
            done(false)
          }}
          onDone={(value) => done(value)}
        />
      ),
      () => {
        stopped = true
        done(false)
      },
    )
  })
}
