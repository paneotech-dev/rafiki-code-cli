/** @jsxImportSource @opentui/solid */
// Shift+Tab cycles the permission mode (ask, auto, plan); the previous agent
// has no key by default any more.
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { TuiKeybind } from "../../src/config/keybind"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"

test("the defaults", () => {
  const keybinds = TuiKeybind.parse({}) as Record<string, unknown>
  expect(keybinds["permission_mode_cycle"]).toBe("shift+tab")
  expect(keybinds["agent_cycle_reverse"]).toBe("none")
  expect(keybinds["agent_cycle"]).toBe("tab")
  expect(TuiKeybind.CommandMap.permission_mode_cycle).toBe("permission.mode.cycle")
})

test("Shift+Tab runs the permission mode cycle", async () => {
  const ran: string[] = []

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const keybinds = TuiKeybind.parse({})
    const config = {
      keybinds: createBindingLookup(TuiKeybind.toBindingConfig(keybinds), {
        commandMap: TuiKeybind.CommandMap,
        bindingDefaults: TuiKeybind.bindingDefaults(),
      }),
      leader_timeout: 2000,
    }
    const offKeymap = registerOpencodeKeymap(keymap, renderer, config)
    const offLayer = keymap.registerLayer({
      commands: [
        { name: "permission.mode.cycle", run: () => void ran.push("permission.mode.cycle") },
        { name: "agent.cycle", run: () => void ran.push("agent.cycle") },
        { name: "agent.cycle.reverse", run: () => void ran.push("agent.cycle.reverse") },
      ],
      bindings: config.keybinds.gather("test.app", ["permission.mode.cycle", "agent.cycle", "agent.cycle.reverse"]),
    })
    onCleanup(() => {
      offLayer()
      offKeymap()
    })
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <box />
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />)
  try {
    app.mockInput.pressTab({ shift: true })
    await Bun.sleep(20)
    app.mockInput.pressTab()
    await Bun.sleep(20)
    expect(ran).toEqual(["permission.mode.cycle", "agent.cycle"])
  } finally {
    app.renderer.destroy()
  }
})
