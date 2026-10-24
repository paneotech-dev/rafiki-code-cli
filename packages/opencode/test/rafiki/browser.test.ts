// The browser behind the screenshot tool (rafiki/browser.ts): finding one,
// the install hint, the text the model reads, and a real capture on the
// system Chrome or Chromium when there is one (skipped otherwise). Every
// capture must leave no browser process behind.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import * as Browser from "../../src/rafiki/browser"

describe("viewport", () => {
  test("names and sizes", () => {
    expect(Browser.viewport("desktop")).toEqual({ name: "desktop", width: 1440, height: 900 })
    expect(Browser.viewport(" Mobile ")).toEqual({ name: "mobile", width: 390, height: 844 })
    expect(Browser.viewport("1280x720")).toEqual({ name: "1280x720", width: 1280, height: 720 })
    expect(Browser.viewport("10x10")).toBeUndefined()
    expect(Browser.viewport("tablet")).toBeUndefined()
  })
})

describe("find", () => {
  test("an explicit path first, then the PATH, then the usual folders", () => {
    const exists = (file: string) => file === "/custom/chrome" || file === "/opt/google/chrome/chrome"
    expect(Browser.find({ platform: "linux", env: { RAFIKICODE_BROWSER: "/custom/chrome" }, exists, which: () => "/usr/bin/chromium" })).toBe(
      "/custom/chrome",
    )
    expect(Browser.find({ platform: "linux", env: {}, exists, which: (name) => (name === "chromium" ? "/usr/bin/chromium" : null) })).toBe(
      "/usr/bin/chromium",
    )
    expect(Browser.find({ platform: "linux", env: {}, exists, which: () => null })).toBe("/opt/google/chrome/chrome")
    expect(Browser.find({ platform: "linux", env: {}, exists: () => false, which: () => null })).toBeUndefined()
  })

  test("macOS and Windows folders", () => {
    const mac = Browser.candidates("darwin", { HOME: "/Users/a" })
    expect(mac).toContain("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    const win = Browser.candidates("win32", { ProgramFiles: "C:\\Program Files" })
    expect(win).toContain("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
    expect(win).toContain("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe")
  })

  test("no browser: one install command for the system, nothing bundled", () => {
    expect(Browser.installHint("darwin")).toBe("brew install --cask google-chrome")
    expect(Browser.installHint("win32")).toBe("winget install Google.Chrome")
    expect(Browser.installHint("linux", 'ID=ubuntu\nID_LIKE="debian"')).toBe("sudo apt install chromium")
    expect(Browser.installHint("linux", "ID=fedora")).toBe("sudo dnf install chromium")
    expect(Browser.installHint("linux", "ID=arch")).toBe("sudo pacman -S chromium")
    expect(Browser.missingMessage("win32")).toContain("winget install Google.Chrome")
    expect(Browser.missingMessage("win32")).toContain("RAFIKICODE_BROWSER")
  })
})

describe("console lines", () => {
  test("errors, exceptions and failed loads; other messages are left out", () => {
    expect(
      Browser.consoleLine({
        method: "Runtime.consoleAPICalled",
        params: { type: "error", args: [{ type: "string", value: "boom" }], stackTrace: { callFrames: [{ url: "http://x/app.js", lineNumber: 4 }] } },
      }),
    ).toBe("console.error: boom (app.js:5)")
    expect(Browser.consoleLine({ method: "Runtime.consoleAPICalled", params: { type: "log", args: [{ value: "hi" }] } })).toBeUndefined()
    expect(
      Browser.consoleLine({
        method: "Runtime.exceptionThrown",
        params: { exceptionDetails: { exception: { description: "TypeError: x is undefined\n    at f" } } },
      }),
    ).toBe("uncaught: TypeError: x is undefined")
    expect(
      Browser.consoleLine({ method: "Log.entryAdded", params: { entry: { level: "error", source: "network", text: "404", url: "http://x/a.png" } } }),
    ).toBe("network: 404 http://x/a.png")
    expect(Browser.consoleLine({ method: "Log.entryAdded", params: { entry: { level: "warning", text: "w" } } })).toBeUndefined()
  })
})

describe("describe", () => {
  const report: Browser.Report = {
    title: "Home",
    url: "file:///x.html",
    viewport: { w: 390, h: 844 },
    page: { w: 620, h: 1200 },
    overflowX: true,
    overflowing: [{ el: "div.wide", right: 620 }],
    overlaps: [{ a: "h1", b: "p.lead", area: 900 }],
    boxes: [{ el: "header", x: 0, y: 0, w: 390, h: 64 }],
    contrast: { checked: 4, failing: [{ el: "p.muted", text: "faint", ratio: 1.6, need: 4.5, fg: "#cccccc", bg: "#ffffff" }] },
    smallText: 1,
    smallTargets: [{ el: "a", w: 12, h: 12 }],
    missing: { imgAlt: 1, inputLabel: 1, buttonName: 0, h1: 1 },
  }
  test("every check in plain words", () => {
    const text = Browser.describe({ viewport: Browser.VIEWPORTS.mobile, report, console: ["uncaught: Error: x"] })
    expect(text).toContain("horizontal overflow: the page is 620px wide in a 390px viewport; past the right edge: div.wide (to 620px)")
    expect(text).toContain("overlapping: h1 covers p.lead (900px2)")
    expect(text).toContain('p.muted "faint" 1.6:1 (needs 4.5:1, #cccccc on #ffffff)')
    expect(text).toContain("1 images without alt")
    expect(text).toContain("1 form fields without a label")
    expect(text).toContain("console errors: uncaught: Error: x")
    expect(text).toContain("boxes: header 0,0 390x64")
  })
  test("a clean page", () => {
    const clean = { ...report, overflowX: false, overflowing: [], overlaps: [], contrast: { checked: 3, failing: [] }, smallText: 0, smallTargets: [], missing: { imgAlt: 0, inputLabel: 0, buttonName: 0, h1: 1 } }
    const text = Browser.describe({ viewport: Browser.VIEWPORTS.desktop, report: clean, console: [] })
    expect(text).toContain("horizontal overflow: none")
    expect(text).toContain("overlapping: none")
    expect(text).toContain("contrast: all 3 measured text elements pass")
    expect(text).toContain("console errors: none")
    expect(text).not.toContain("accessibility")
  })
})

// ---------------------------------------------------------------------------
// A real browser.

const browser = Browser.find()
const real = browser && Browser.usable(browser) ? test : test.skip
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-test-"))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

// Browser processes started with one of our profiles (the folder name is
// rafikicode-browser-...).
function ours() {
  const out = spawnSync("ps", ["-eo", "args"], { encoding: "utf8" }).stdout ?? ""
  return out.split("\n").filter((line) => line.includes("-browser-") && line.includes("--user-data-dir") && !line.includes("ps -eo"))
}

const PAGE = `<!doctype html><html><head><title>Broken</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body { margin: 0; font: 16px sans-serif; background: #fff; }
.wide { width: 900px; height: 40px; background: #eee; }
.muted { color: #d0d0d0; }
.a { position: absolute; top: 200px; left: 10px; width: 200px; }
.b { position: absolute; top: 205px; left: 20px; width: 200px; }
</style></head><body>
<header><h1>Shop</h1></header>
<div class="wide">wide</div>
<p class="muted">hard to read</p>
<p class="a">first block of text</p>
<p class="b">second block of text</p>
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
<input type="text">
<script>console.error("app failed to start"); setTimeout(() => { throw new Error("late failure") }, 0)</script>
</body></html>`

describe("capture", () => {
  real(
    "measures a page at desktop and mobile, collects console errors, and stops the browser",
    async () => {
      const file = path.join(dir, "broken.html")
      fs.writeFileSync(file, PAGE)
      const shots = await Browser.capture({
        browser: browser!,
        url: `file://${file}`,
        viewports: [Browser.VIEWPORTS.desktop, Browser.VIEWPORTS.mobile],
      })
      expect(shots).toHaveLength(2)
      const [desktop, mobile] = shots
      expect(desktop!.error).toBeUndefined()
      expect(desktop!.report!.title).toBe("Broken")
      expect(desktop!.report!.overflowX).toBe(false)
      expect(mobile!.report!.overflowX).toBe(true)
      expect(mobile!.report!.overflowing.map((item) => item.el)).toContain("div.wide")
      expect(desktop!.report!.overlaps.some((item) => item.a === "p.a" && item.b === "p.b")).toBe(true)
      expect(desktop!.report!.contrast.failing.map((item) => item.el)).toContain("p.muted")
      expect(desktop!.report!.missing).toMatchObject({ imgAlt: 1, inputLabel: 1, h1: 1 })
      expect(desktop!.console.join("\n")).toContain("console.error: app failed to start")
      expect(desktop!.console.join("\n")).toContain("late failure")
      // A PNG of the viewport.
      expect(desktop!.image!.mime).toBe("image/png")
      expect(Buffer.from(desktop!.image!.data, "base64").subarray(1, 4).toString()).toBe("PNG")
      expect(Browser.liveCount()).toBe(0)
      await Bun.sleep(300)
      expect(ours()).toEqual([])
    },
    60_000,
  )

  real(
    "a page that never answers: the deadline stops the browser",
    async () => {
      const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
      try {
        const started = Date.now()
        const result = await Browser.capture({
          browser: browser!,
          url: `http://127.0.0.1:${server.port}/`,
          viewports: [Browser.VIEWPORTS.desktop, Browser.VIEWPORTS.mobile],
          timeoutMs: 20_000,
          deadlineMs: 3_000,
        }).then(
          (shots) => shots.map((shot) => shot.error ?? shot.note ?? "").join(" | "),
          (error: Error) => error.message,
        )
        expect(Date.now() - started).toBeLessThan(15_000)
        expect(result).toContain("ran out of its 3s")
        expect(Browser.liveCount()).toBe(0)
        await Bun.sleep(300)
        expect(ours()).toEqual([])
      } finally {
        server.stop(true)
      }
    },
    60_000,
  )
})
