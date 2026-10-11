import { createMemo, createSignal, onCleanup } from "solid-js"
import * as PermissionModes from "@opencode-ai/core/brand/permission-mode"
import { useArgs } from "./args"
import { useSDK } from "./sdk"
import { createSimpleContext } from "./helper"

// The permission mode (ask, auto, plan), cycled with Shift+Tab. The pick is
// kept per project in the state folder (core/brand/permission-mode.ts), where
// the server started by this interface reads it on every question.
export type PermissionMode = PermissionModes.Mode

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const args = useArgs()
    const sdk = useSDK()
    const directory = sdk.directory ?? process.cwd()
    const [config, setConfig] = createSignal<unknown>(undefined)
    // Another window on the same project may change the pick: read it again now and then.
    const [tick, setTick] = createSignal(0)
    const timer = setInterval(() => setTick((value) => value + 1), 2_000)
    timer.unref?.()
    onCleanup(() => clearInterval(timer))
    const env = () => (args.auto ? { ...process.env, [PermissionModes.ENV]: "auto" } : process.env)
    const mode = createMemo(() => {
      tick()
      return PermissionModes.resolve({ directory, config: config(), saved: true, env: env() }).mode
    })
    const set = (next: PermissionMode) => {
      try {
        PermissionModes.save(directory, next)
      } catch (error) {
        console.error("Failed to save the permission mode", { error })
      }
      setTick((value) => value + 1)
    }
    return {
      get mode() {
        return mode()
      },
      set,
      cycle() {
        set(PermissionModes.next(mode()))
        return mode()
      },
      toggle() {
        set(mode() === "auto" ? "ask" : "auto")
      },
      // The permission config of the server, for "permission": { "mode": ... }.
      setConfig(value: unknown) {
        setConfig(() => value)
      },
    }
  },
})
