// The browser behind the screenshot tool (tool/screenshot.ts): an installed
// Chrome, Chromium, Edge or Brave, started headless and driven over the
// DevTools protocol on a WebSocket. No browser is bundled and no package is
// added: every desktop system has one of these, or one install command away
// (installHint).
//
// One capture opens the browser once, loads the page at each viewport, measures
// it (element boxes, sideways overflow, overlapping elements, text contrast,
// missing labels), collects the console errors and takes a picture. The measures
// are the whole answer for a model that takes no images.
//
// The browser runs in a process group of its own and the whole group is killed
// when the capture ends, fails or runs out of time (deadline), and when this
// process exits: no capture leaves a browser behind.
import fs from "fs"
import os from "os"
import path from "path"
import { spawn, spawnSync } from "child_process"
import { Brand } from "@opencode-ai/core/brand/brand"

export interface Viewport {
  name: string
  width: number
  height: number
}

export const VIEWPORTS: Record<"desktop" | "mobile", Viewport> = {
  desktop: { name: "desktop", width: 1440, height: 900 },
  mobile: { name: "mobile", width: 390, height: 844 },
}

// "desktop", "mobile" or "1280x720".
export function viewport(value: string): Viewport | undefined {
  const text = value.trim().toLowerCase()
  if (text === "desktop" || text === "mobile") return VIEWPORTS[text]
  const match = text.match(/^(\d{2,5})\s*x\s*(\d{2,5})$/)
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (width < 200 || height < 200 || width > 3840 || height > 4000) return undefined
  return { name: `${width}x${height}`, width, height }
}

// ---------------------------------------------------------------------------
// Finding the browser.

type Env = Record<string, string | undefined>

const LINUX_NAMES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "microsoft-edge-stable",
  "microsoft-edge",
  "brave-browser",
]
const LINUX_PATHS = ["/opt/google/chrome/chrome", "/snap/bin/chromium", "/usr/lib/chromium/chromium", "/opt/microsoft/msedge/msedge"]
const MAC_APPS = [
  "Google Chrome.app/Contents/MacOS/Google Chrome",
  "Chromium.app/Contents/MacOS/Chromium",
  "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "Brave Browser.app/Contents/MacOS/Brave Browser",
]
const WINDOWS_EXES = [
  "Google\\Chrome\\Application\\chrome.exe",
  "Microsoft\\Edge\\Application\\msedge.exe",
  "Chromium\\Application\\chrome.exe",
  "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
]

// Every place looked at, in order.
export function candidates(platform: NodeJS.Platform = process.platform, env: Env = process.env): string[] {
  const own = [env[Brand.env.browser], env.CHROME_PATH].filter((item): item is string => !!item)
  if (platform === "darwin") {
    const home = env.HOME ?? os.homedir()
    return [...own, ...MAC_APPS.flatMap((app) => [path.posix.join("/Applications", app), path.posix.join(home, "Applications", app)])]
  }
  if (platform === "win32") {
    const roots = [env.ProgramFiles ?? env.PROGRAMFILES, env["ProgramFiles(x86)"] ?? env["PROGRAMFILES(X86)"], env.LocalAppData ?? env.LOCALAPPDATA]
    return [...own, ...WINDOWS_EXES.flatMap((exe) => roots.filter((root): root is string => !!root).map((root) => path.win32.join(root, exe)))]
  }
  return [...own, ...LINUX_PATHS]
}

export function find(
  input: {
    platform?: NodeJS.Platform
    env?: Env
    exists?: (file: string) => boolean
    which?: (name: string) => string | null | undefined
  } = {},
): string | undefined {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const exists = input.exists ?? ((file: string) => fs.existsSync(file))
  const which = input.which ?? ((name: string) => Bun.which(name))
  // An explicit choice first, then a browser on the PATH, then the usual folders.
  const explicit = [env[Brand.env.browser], env.CHROME_PATH].find((item) => item && exists(item))
  if (explicit) return explicit
  if (platform !== "darwin" && platform !== "win32") {
    const found = LINUX_NAMES.map((name) => which(name)).find((item) => !!item)
    if (found) return found
  }
  return candidates(platform, env).find((file) => exists(file))
}

// The one command that installs a browser on this system.
export function installHint(platform: NodeJS.Platform = process.platform, osRelease?: string): string {
  if (platform === "darwin") return "brew install --cask google-chrome"
  if (platform === "win32") return "winget install Google.Chrome"
  const release = osRelease ?? readOsRelease()
  const ids = [release.match(/^ID=(.*)$/m)?.[1], release.match(/^ID_LIKE=(.*)$/m)?.[1]]
    .join(" ")
    .replaceAll('"', "")
    .toLowerCase()
  if (/\b(fedora|rhel|centos|rocky|almalinux)\b/.test(ids)) return "sudo dnf install chromium"
  if (/\b(arch|manjaro|endeavouros)\b/.test(ids)) return "sudo pacman -S chromium"
  if (/\balpine\b/.test(ids)) return "sudo apk add chromium"
  if (/\b(suse|opensuse)\b/.test(ids)) return "sudo zypper install chromium"
  return "sudo apt install chromium"
}

function readOsRelease() {
  try {
    return fs.readFileSync("/etc/os-release", "utf8")
  } catch {
    return ""
  }
}

export function missingMessage(platform: NodeJS.Platform = process.platform) {
  return `No Chrome, Chromium, Edge or Brave browser was found, so no screenshot can be taken. Install one with: ${installHint(platform)}. A browser in another place is used when ${Brand.env.browser} names its path.`
}

// ---------------------------------------------------------------------------
// The DevTools protocol over a WebSocket.

type Message = { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string }

class Cdp {
  private next = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private listeners = new Set<(message: Message) => void>()

  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Message
      if (message.id !== undefined) {
        const waiting = this.pending.get(message.id)
        if (!waiting) return
        this.pending.delete(message.id)
        if (message.error) waiting.reject(new Error(message.error.message))
        else waiting.resolve(message.result)
        return
      }
      for (const listener of this.listeners) listener(message)
    })
    socket.addEventListener("close", () => {
      for (const waiting of this.pending.values()) waiting.reject(new Error("the browser closed the connection"))
      this.pending.clear()
    })
  }

  static connect(url: string, timeoutMs: number) {
    return new Promise<Cdp>((resolve, reject) => {
      const socket = new WebSocket(url)
      const timer = setTimeout(() => reject(new Error("the browser did not accept the connection")), timeoutMs)
      socket.addEventListener("open", () => {
        clearTimeout(timer)
        resolve(new Cdp(socket))
      })
      socket.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("the browser did not accept the connection"))
      })
    })
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000) {
    const id = ++this.next
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} took longer than ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  // Resolves on the first event of this name for the session, false after the timeout.
  event(method: string, sessionId: string, timeoutMs: number) {
    return new Promise<boolean>((resolve) => {
      const listener = (message: Message) => {
        if (message.method !== method || message.sessionId !== sessionId) return
        done(true)
      }
      const done = (value: boolean) => {
        clearTimeout(timer)
        this.listeners.delete(listener)
        resolve(value)
      }
      const timer = setTimeout(() => done(false), timeoutMs)
      this.listeners.add(listener)
    })
  }

  // Every event, until the returned function is called.
  on(listener: (message: Message) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  close() {
    this.socket.close()
  }
}

// Browsers started by this process and not closed yet, killed on exit.
const live = new Set<() => void>()
let exitHooked = false
function track(kill: () => void) {
  if (!exitHooked) {
    exitHooked = true
    process.once("exit", () => {
      for (const item of [...live]) item()
    })
  }
  live.add(kill)
  return () => live.delete(kill)
}

// For tests: browsers started and not closed yet.
export function liveCount() {
  return live.size
}

interface Running {
  cdp: Cdp
  close(): Promise<void>
  kill(): void
}

async function launch(browser: string, timeoutMs: number): Promise<Running> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `${Brand.name}-browser-`))
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--hide-scrollbars",
    "--mute-audio",
    "--disable-dev-shm-usage",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    // Chrome refuses to start as root with its sandbox on.
    ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    "about:blank",
  ]
  // A group of its own on Linux and macOS, so the renderer and helper processes
  // go with it.
  const group = process.platform !== "win32"
  const child = spawn(browser, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, detached: group })
  const kill = () => {
    if (!child.pid) return
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      return
    }
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      if (child.exitCode === null) child.kill("SIGKILL")
    }
  }
  const untrack = track(kill)
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    kill()
    untrack()
    // Chrome may still hold files for a moment, on Windows above all.
    for (const delay of [0, 200, 1000]) {
      try {
        if (delay) Bun.sleepSync(delay)
        fs.rmSync(profile, { recursive: true, force: true })
        return
      } catch {}
    }
  }
  const url = await new Promise<string>((resolve, reject) => {
    let output = ""
    const timer = setTimeout(() => fail(`the browser did not start within ${Math.round(timeoutMs / 1000)}s`), timeoutMs)
    const fail = (reason: string) => {
      clearTimeout(timer)
      cleanup()
      const tail = output.trim().split("\n").slice(-3).join(" ").slice(0, 400)
      reject(new Error(tail ? `${reason}: ${tail}` : reason))
    }
    child.stderr!.on("data", (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/)
      if (!match) return
      clearTimeout(timer)
      resolve(match[1])
    })
    child.on("error", (error) => fail(`the browser could not be started (${error.message})`))
    child.on("exit", (code) => fail(`the browser exited with code ${code}`))
  })
  child.stderr!.removeAllListeners("data")
  // Keep draining stderr so a chatty browser never blocks on a full pipe.
  child.stderr!.on("data", () => {})
  const cdp = await Cdp.connect(url, 10_000).catch((error) => {
    cleanup()
    throw error
  })
  return {
    cdp,
    async close() {
      if (cleaned) return
      await cdp.send("Browser.close", {}, undefined, 2_000).catch(() => {})
      cdp.close()
      cleanup()
    },
    kill() {
      cdp.close()
      cleanup()
    },
  }
}

// ---------------------------------------------------------------------------
// What the page looks like in numbers.

export interface Box {
  el: string
  x: number
  y: number
  w: number
  h: number
}

export interface Report {
  title: string
  url: string
  viewport: { w: number; h: number }
  page: { w: number; h: number }
  overflowX: boolean
  overflowing: { el: string; right: number }[]
  overlaps: { a: string; b: string; area: number }[]
  boxes: Box[]
  contrast: { checked: number; failing: { el: string; text: string; ratio: number; need: number; fg: string; bg: string }[] }
  smallText: number
  smallTargets: { el: string; w: number; h: number }[]
  missing: { imgAlt: number; inputLabel: number; buttonName: number; h1: number }
}

// Runs inside the page. Kept as plain JavaScript in a string: it is sent as is.
// The width is the viewport asked for: on a mobile viewport the browser widens
// its layout viewport (innerWidth) to fit content that overflows.
export const REPORT_SCRIPT = String.raw`((vw) => {
  const vh = window.innerHeight
  const de = document.documentElement
  const label = (el) => {
    let s = el.tagName.toLowerCase()
    if (el.id) s += "#" + el.id
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : []
    if (cls.length) s += "." + cls.join(".")
    return s.slice(0, 60)
  }
  const visible = (el) => {
    const st = getComputedStyle(el)
    if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  const rgba = (color) => {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = "rgba(0,0,0,0)"
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3] / 255]
  }
  const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1)
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
  }
  const hex = (c) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")
  // The colour behind an element, or null when an image or gradient is in the way.
  const background = (el) => {
    const layers = []
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const st = getComputedStyle(node)
      if (st.backgroundImage && st.backgroundImage !== "none") return null
      const c = rgba(st.backgroundColor)
      if (c[3] > 0) layers.push(c)
      if (c[3] >= 1) break
    }
    return layers.reverse().reduce((acc, c) => over(c, acc), [255, 255, 255, 1])
  }
  const clipped = (el) => {
    for (let node = el.parentElement; node && node !== document.body && node !== de; node = node.parentElement) {
      const ox = getComputedStyle(node).overflowX
      if (ox === "hidden" || ox === "auto" || ox === "scroll" || ox === "clip") {
        const r = node.getBoundingClientRect()
        if (r.right <= vw + 1) return true
      }
    }
    return false
  }
  const all = Array.from(document.body ? document.body.querySelectorAll("*") : [])
  const overflowing = []
  for (const el of all) {
    if (overflowing.length >= 8) break
    if (el.closest("script,style,noscript,svg *")) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.right <= vw + 1) continue
    if (getComputedStyle(el).position === "fixed" && r.left >= vw) continue
    if (!visible(el) || clipped(el)) continue
    if (overflowing.some((o) => o.node.contains(el))) continue
    overflowing.push({ node: el, el: label(el), right: Math.round(r.right + window.scrollX) })
  }
  // Content that covers other content: text, controls and pictures whose boxes
  // cross by more than a quarter of the smaller one, neither inside the other.
  // Fixed and sticky elements are left out: they sit over the page on purpose.
  const pinned = (el) => {
    for (let node = el; node && node !== de; node = node.parentElement) {
      const p = getComputedStyle(node).position
      if (p === "fixed" || p === "sticky") return true
    }
    return false
  }
  const ownText = (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)
  const leaves = all
    .filter((el) => !el.closest("script,style,noscript,svg *,option"))
    .filter((el) => /^(IMG|VIDEO|CANVAS|SVG|INPUT|SELECT|TEXTAREA|BUTTON)$/i.test(el.tagName) || ownText(el))
    .filter(visible)
    .slice(0, 400)
    .filter((el) => !pinned(el))
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter((item) => item.r.width >= 4 && item.r.height >= 4)
  const overlaps = []
  for (let i = 0; i < leaves.length && overlaps.length < 6; i++) {
    for (let j = i + 1; j < leaves.length && overlaps.length < 6; j++) {
      const a = leaves[i], b = leaves[j]
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left)
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top)
      if (w <= 2 || h <= 2) continue
      const area = w * h
      const smaller = Math.min(a.r.width * a.r.height, b.r.width * b.r.height)
      if (area < 0.25 * smaller || area < 64) continue
      overlaps.push({ a: label(a.el), b: label(b.el), area: Math.round(area) })
    }
  }
  const boxes = Array.from(document.querySelectorAll("header,nav,main,footer,aside,section,form,h1,h2"))
    .filter(visible)
    .slice(0, 16)
    .map((el) => { const r = el.getBoundingClientRect(); return { el: label(el), x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) } })
  const texts = all.filter((el) => !el.closest("script,style,noscript,svg") && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)).filter(visible).slice(0, 600)
  const failing = []
  let checked = 0, smallText = 0
  for (const el of texts) {
    const st = getComputedStyle(el)
    const size = parseFloat(st.fontSize)
    if (size < 12) smallText++
    const bg = background(el)
    if (!bg) continue
    const fgRaw = rgba(st.color)
    const fg = over(fgRaw, bg)
    const a = lum(fg), b = lum(bg)
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    const weight = Number(st.fontWeight) || 400
    const need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5
    checked++
    if (ratio + 0.005 < need && failing.length < 10) {
      const text = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ").trim().replace(/\s+/g, " ").slice(0, 40)
      failing.push({ el: label(el), text, ratio: Math.round(ratio * 100) / 100, need, fg: hex(fg), bg: hex(bg) })
    }
  }
  const smallTargets = vw < 768
    ? Array.from(document.querySelectorAll("a,button,input,select,textarea,[role=button]")).filter(visible)
        .map((el) => ({ el: label(el), r: el.getBoundingClientRect() }))
        .filter((t) => t.r.width < 24 || t.r.height < 24)
        .slice(0, 6)
        .map((t) => ({ el: t.el, w: Math.round(t.r.width), h: Math.round(t.r.height) }))
    : []
  const named = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim().length > 0
  const labelled = (el) => el.type === "hidden" || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.closest("label") || (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]'))
  return {
    title: document.title,
    url: location.href,
    viewport: { w: vw, h: vh },
    page: { w: de.scrollWidth, h: de.scrollHeight },
    overflowX: de.scrollWidth > vw + 1,
    overflowing: overflowing.map((o) => ({ el: o.el, right: o.right })),
    overlaps,
    boxes,
    contrast: { checked, failing },
    smallText,
    smallTargets,
    missing: {
      imgAlt: document.querySelectorAll("img:not([alt])").length,
      inputLabel: Array.from(document.querySelectorAll("input,select,textarea")).filter((el) => !labelled(el)).length,
      buttonName: Array.from(document.querySelectorAll("button,[role=button]")).filter((el) => !named(el)).length,
      h1: document.querySelectorAll("h1").length,
    },
  }
})`

export interface Shot {
  viewport: Viewport
  report?: Report
  // Console errors, uncaught exceptions and failed loads, as the page printed them.
  console: string[]
  image?: { mime: string; data: string }
  error?: string
  note?: string
}

// Opens the page at each viewport, measures it and takes a picture.
export async function capture(input: {
  browser: string
  url: string
  viewports: Viewport[]
  fullPage?: boolean
  image?: boolean
  timeoutMs?: number
  // The whole capture, every viewport included. The browser is killed then.
  deadlineMs?: number
}): Promise<Shot[]> {
  const timeoutMs = input.timeoutMs ?? 30_000
  const deadlineMs = input.deadlineMs ?? 90_000
  const running = await launch(input.browser, Math.min(timeoutMs, 30_000))
  const cdp = running.cdp
  let expired = false
  const deadline = setTimeout(() => {
    expired = true
    running.kill()
  }, deadlineMs)
  try {
    const shots: Shot[] = []
    for (const view of input.viewports) {
      if (expired) {
        shots.push({ viewport: view, console: [], error: `not taken: the capture ran out of its ${Math.round(deadlineMs / 1000)}s` })
        continue
      }
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" })
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true })
      const shot: Shot = { viewport: view, console: [] }
      const stopListening = cdp.on((message) => {
        if (message.sessionId !== sessionId) return
        const line = consoleLine(message)
        if (line && shot.console.length < 20 && !shot.console.includes(line)) shot.console.push(line)
      })
      try {
        await cdp.send("Page.enable", {}, sessionId)
        await cdp.send("Runtime.enable", {}, sessionId)
        await cdp.send("Log.enable", {}, sessionId)
        await cdp.send(
          "Emulation.setDeviceMetricsOverride",
          { width: view.width, height: view.height, deviceScaleFactor: 1, mobile: view.width < 768 },
          sessionId,
        )
        const loaded = cdp.event("Page.loadEventFired", sessionId, timeoutMs)
        const navigation = await cdp.send("Page.navigate", { url: input.url }, sessionId, timeoutMs)
        if (navigation.errorText) {
          shot.error = `the page could not be opened (${navigation.errorText})`
          shots.push(shot)
          continue
        }
        if (!(await loaded)) shot.note = `the page had not finished loading after ${Math.round(timeoutMs / 1000)}s`
        await cdp
          .send(
            "Runtime.evaluate",
            { expression: "document.fonts ? document.fonts.ready.then(() => true) : true", awaitPromise: true },
            sessionId,
            5_000,
          )
          .catch(() => {})
        await Bun.sleep(300)
        const evaluated = await cdp.send(
          "Runtime.evaluate",
          { expression: `${REPORT_SCRIPT}(${view.width})`, returnByValue: true },
          sessionId,
          15_000,
        )
        if (evaluated.exceptionDetails) shot.note = "the page could not be measured"
        else shot.report = evaluated.result.value as Report
        if (input.image !== false) {
          const height = input.fullPage
            ? Math.min(8_000, Math.max(view.height, Math.ceil(shot.report?.page.h ?? view.height)))
            : view.height
          const picture = await cdp.send(
            "Page.captureScreenshot",
            input.fullPage
              ? {
                  format: "jpeg",
                  quality: 80,
                  captureBeyondViewport: true,
                  clip: { x: 0, y: 0, width: view.width, height, scale: 1 },
                }
              : { format: "png" },
            sessionId,
            timeoutMs,
          )
          shot.image = { mime: input.fullPage ? "image/jpeg" : "image/png", data: picture.data }
        }
      } catch (error) {
        shot.error = expired
          ? `the capture ran out of its ${Math.round(deadlineMs / 1000)}s and the browser was stopped`
          : error instanceof Error
            ? error.message
            : String(error)
      } finally {
        stopListening()
        await cdp.send("Target.closeTarget", { targetId }, undefined, 5_000).catch(() => {})
      }
      shots.push(shot)
    }
    return shots
  } catch (error) {
    if (expired) throw new Error(`the capture ran out of its ${Math.round(deadlineMs / 1000)}s and the browser was stopped`)
    throw error
  } finally {
    clearTimeout(deadline)
    await running.close()
  }
}

// One line for a console error, an uncaught exception or a failed load.
export function consoleLine(message: { method?: string; params?: any }): string | undefined {
  const params = message.params ?? {}
  const where = (url?: string, line?: number) => (url ? ` (${url.split("/").pop() || url}${line !== undefined ? `:${line + 1}` : ""})` : "")
  if (message.method === "Runtime.consoleAPICalled" && (params.type === "error" || params.type === "assert")) {
    const text = (params.args ?? [])
      .map((arg: any) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? arg.type ?? "")))
      .join(" ")
    const frame = params.stackTrace?.callFrames?.[0]
    return `console.error: ${text}`.slice(0, 300) + where(frame?.url, frame?.lineNumber)
  }
  if (message.method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails ?? {}
    const text = details.exception?.description?.split("\n")[0] ?? details.text ?? "exception"
    return `uncaught: ${text}`.slice(0, 300) + where(details.url, details.lineNumber)
  }
  if (message.method === "Log.entryAdded" && params.entry?.level === "error") {
    const entry = params.entry
    return `${entry.source ?? "log"}: ${String(entry.text ?? "").slice(0, 200)}${entry.url ? ` ${entry.url}` : ""}`.slice(0, 300)
  }
  return undefined
}

// The measures as text, for the model.
export function describe(shot: Shot): string {
  const head = `${shot.viewport.name} ${shot.viewport.width}x${shot.viewport.height}`
  if (shot.error) return `${head}: ${shot.error}`
  const report = shot.report
  if (!report) return `${head}: ${shot.note ?? "no measures"}`
  const lines = [`${head}: "${report.title}" ${report.page.w}x${report.page.h}px${shot.note ? ` (${shot.note})` : ""}`]
  lines.push(
    report.overflowX
      ? `  horizontal overflow: the page is ${report.page.w}px wide in a ${shot.viewport.width}px viewport${
          report.overflowing.length ? `; past the right edge: ${report.overflowing.map((item) => `${item.el} (to ${item.right}px)`).join(", ")}` : ""
        }`
      : "  horizontal overflow: none",
  )
  lines.push(
    report.overlaps.length
      ? `  overlapping: ${report.overlaps.map((item) => `${item.a} covers ${item.b} (${item.area}px2)`).join("; ")}`
      : "  overlapping: none",
  )
  const failing = report.contrast.failing
  lines.push(
    failing.length
      ? `  contrast: ${failing.length} of ${report.contrast.checked} text elements below the minimum: ${failing
          .map((item) => `${item.el} "${item.text}" ${item.ratio}:1 (needs ${item.need}:1, ${item.fg} on ${item.bg})`)
          .join("; ")}`
      : `  contrast: all ${report.contrast.checked} measured text elements pass`,
  )
  const missing = [
    report.missing.h1 === 1 ? "" : `${report.missing.h1} h1 elements (one expected)`,
    report.missing.imgAlt ? `${report.missing.imgAlt} images without alt` : "",
    report.missing.inputLabel ? `${report.missing.inputLabel} form fields without a label` : "",
    report.missing.buttonName ? `${report.missing.buttonName} buttons without a name` : "",
    report.smallText ? `${report.smallText} text elements under 12px` : "",
    report.smallTargets.length
      ? `touch targets under 24px: ${report.smallTargets.map((item) => `${item.el} ${item.w}x${item.h}`).join(", ")}`
      : "",
  ].filter(Boolean)
  if (missing.length) lines.push(`  accessibility: ${missing.join("; ")}`)
  lines.push(shot.console.length ? `  console errors: ${shot.console.join(" | ")}` : "  console errors: none")
  if (report.boxes.length)
    lines.push(`  boxes: ${report.boxes.map((box) => `${box.el} ${box.x},${box.y} ${box.w}x${box.h}`).join("; ")}`)
  return lines.join("\n")
}

// For tests: whether a browser can start here at all.
export function usable(browser: string) {
  const result = spawnSync(browser, ["--version"], { encoding: "utf8", timeout: 10_000 })
  return result.status === 0
}
