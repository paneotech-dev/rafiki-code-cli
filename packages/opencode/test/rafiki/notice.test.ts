// Workspace-trust warnings on their way to the terminal interface.
//
// brand/trust.ts writes them to stderr, which the full-screen interface owns:
// there they are swallowed or scribbled over the frame, and a person whose
// project plugins, custom tools and permission grants are being dropped sees one
// line they never read. setWarn exists to redirect them and nothing called it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Guard from "@opencode-ai/core/brand/guard"
import * as Trust from "@opencode-ai/core/brand/trust"
import { TuiEvent } from "@opencode-ai/schema/tui-event"
import { installTrustNotices, stripPrefix, toastEvent, TRUST_TITLE } from "../../src/rafiki/notice"
import { createEventSource } from "../../src/cli/cmd/tui"
import { Rpc } from "../../src/util/rpc"

const upstreamWord = /(?<![A-Z_])opencode(?![A-Z_])/i

describe("trust warnings become toast events", () => {
  test("the event is the one the interface already renders", () => {
    const event = toastEvent("Warning: not loading 2 project plugins from /repo: this workspace is not trusted.")
    expect(event.payload.type).toBe(TuiEvent.ToastShow.type)
    expect(event.payload.properties.variant).toBe("warning")
    expect(event.payload.properties.title).toBe(TRUST_TITLE)
    expect(event.payload.properties.duration).toBeGreaterThan(0)
    expect(event.directory).toBe("global")
  })

  test("the title carries the message, so the stderr prefix is dropped", () => {
    expect(toastEvent("Warning: something").payload.properties.message).toBe("something")
    expect(stripPrefix("Warning:   spaced")).toBe("spaced")
    expect(stripPrefix("no prefix here")).toBe("no prefix here")
  })

  test("nothing in the event names the upstream project", () => {
    expect(JSON.stringify(toastEvent("Warning: x"))).not.toMatch(upstreamWord)
  })
})

describe("installTrustNotices", () => {
  let home: string
  let restore: (message: string) => void

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-notice-"))
    Guard.resetWarnings()
  })

  afterEach(() => {
    Guard.setWarn(restore)
    fs.rmSync(home, { recursive: true, force: true })
  })

  // The real producer: an untrusted directory declaring plugins. Nothing is
  // faked, so a change to the warning text cannot slip past this.
  test("a real trust warning arrives as an event instead of on stderr", () => {
    const events: ReturnType<typeof toastEvent>[] = []
    restore = installTrustNotices((event) => events.push(event))

    const trusted = process.env[Brand.env.trustWorkspace]
    delete process.env[Brand.env.trustWorkspace]
    try {
      const kept = Trust.plugins(home, ["./evil.ts", "./worse.ts"])
      expect(kept).toEqual([])
    } finally {
      if (trusted !== undefined) process.env[Brand.env.trustWorkspace] = trusted
    }

    expect(events).toHaveLength(1)
    expect(events[0]!.payload.properties.variant).toBe("warning")
    expect(events[0]!.payload.properties.message).toContain("not loading 2 project plugins")
    expect(events[0]!.payload.properties.message).toContain(home)
    expect(events[0]!.payload.properties.message).toContain(`${Brand.name} trust`)
    expect(events[0]!.payload.properties.message).not.toStartWith("Warning:")
  })

  test("a trusted workspace produces no warning at all", () => {
    const events: unknown[] = []
    restore = installTrustNotices((event) => events.push(event))
    process.env[Brand.env.trustWorkspace] = "1"
    expect(Trust.plugins(home, ["./fine.ts"])).toEqual(["./fine.ts"])
    expect(events).toEqual([])
  })

  test("the previous sink is returned, so a surface can put it back", () => {
    const first: string[] = []
    const original = Guard.setWarn((m) => first.push(m))
    restore = original
    const second: unknown[] = []
    const previous = installTrustNotices((event) => second.push(event))
    Guard.setWarn(previous)
    Trust.warnOnce("k", "back on the first sink")
    expect(first).toEqual(["back on the first sink"])
    expect(second).toEqual([])
  })
})

// The redirect has to be installed by the surface, and the surface that owns the
// screen is the terminal interface, whose server runs in the worker. Asserted on
// the source because importing the worker starts a server.
describe("the interface's worker installs the redirect", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dir, "../../src/cli/tui/worker.ts"), "utf8")

  test("it calls installTrustNotices", () => {
    expect(source).toContain("installTrustNotices")
  })

  test("it installs before anything can load a config file", () => {
    // Config is loaded from an rpc call, and rpc.listen is the last line; the
    // redirect has to be in place by then or the first warnings are lost.
    expect(source.indexOf("installTrustNotices((")).toBeGreaterThan(-1)
    expect(source.indexOf("installTrustNotices((")).toBeLessThan(source.indexOf("Rpc.listen"))
  })

  test("it sends them onto the bus the interface listens to", () => {
    expect(source).toMatch(/installTrustNotices\(\(event\) => \{\s*GlobalBus\.emit\("event", event\)/)
  })
})

describe("the interface does not lose events raised before it subscribes", () => {
  // The worker emits as soon as it loads a config file, which is where trust
  // warnings come from, and the interface only subscribes once it has mounted.
  function channel() {
    const sent: string[] = []
    const target = {
      postMessage: (data: string) => {
        sent.push(data)
      },
      onmessage: null as ((this: Worker, ev: MessageEvent<any>) => any) | null,
    }
    const client = Rpc.client<any>(target)
    const fromWorker = (event: unknown) => {
      target.onmessage!.call(
        null as any,
        {
          data: JSON.stringify({ type: "rpc.event", event: "global.event", data: event }),
        } as MessageEvent<any>,
      )
    }
    return { client, fromWorker }
  }

  test("events sent before the first subscribe are replayed in order", async () => {
    const { client, fromWorker } = channel()
    const source = createEventSource(client)

    fromWorker(toastEvent("Warning: first"))
    fromWorker(toastEvent("Warning: second"))

    const seen: any[] = []
    await source.subscribe((event) => seen.push(event))
    expect(seen.map((e) => e.payload.properties.message)).toEqual(["first", "second"])
  })

  // The cap is there so a session that never subscribes (an external server owns
  // the events instead) cannot accumulate them for hours.
  test("the newest events survive when the cap is reached", async () => {
    const { client, fromWorker } = channel()
    const source = createEventSource(client, 2)
    for (const n of ["one", "two", "three"]) fromWorker(toastEvent(`Warning: ${n}`))
    const seen: any[] = []
    await source.subscribe((event) => seen.push(event))
    expect(seen.map((e) => e.payload.properties.message)).toEqual(["two", "three"])
  })

  test("events after the subscribe go straight through and are not replayed twice", async () => {
    const { client, fromWorker } = channel()
    const source = createEventSource(client)
    fromWorker(toastEvent("Warning: buffered"))

    const seen: any[] = []
    const unsubscribe = await source.subscribe((event) => seen.push(event))
    fromWorker(toastEvent("Warning: live"))
    expect(seen.map((e) => e.payload.properties.message)).toEqual(["buffered", "live"])

    // Unsubscribing buffers again rather than dropping.
    unsubscribe()
    fromWorker(toastEvent("Warning: after"))
    const later: any[] = []
    await source.subscribe((event) => later.push(event))
    expect(later.map((e) => e.payload.properties.message)).toEqual(["after"])
    expect(seen).toHaveLength(2)
  })
})
