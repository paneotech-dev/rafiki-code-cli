// The screenshot tool's pure parts and the project dev server it can start.
import { describe, expect, test } from "bun:test"
import { isLocal, lookPrompt, target } from "../../src/tool/screenshot"
import * as DevServer from "../../src/rafiki/dev-server"

describe("screenshot targets", () => {
  test("local addresses open without a question", () => {
    for (const url of ["http://localhost:5173/", "http://127.0.0.1:3000/x", "http://[::1]:8080/", "http://app.localhost/", "file:///tmp/a.html"])
      expect(isLocal(url)).toBe(true)
    for (const url of ["https://example.com/", "http://192.168.1.2/", "ftp://localhost/", "not a url"]) expect(isLocal(url)).toBe(false)
  })
  test("paths become file URLs, other schemes are refused", () => {
    expect(target("index.html", "/work/site")).toBe("file:///work/site/index.html")
    expect(target("http://localhost:3000", "/work")).toBe("http://localhost:3000")
    expect(target("javascript://alert(1)", "/work")).toBeUndefined()
  })
  test("the look prompt names the widths and what to look for", () => {
    const text = lookPrompt("http://localhost:3000/", ["desktop", "mobile"], "a pricing table with three plans")
    expect(text).toContain("desktop and mobile")
    expect(text).toContain("a pricing table with three plans")
  })
})

describe("dev server", () => {
  const files = (map: Record<string, string>) => (file: string) => map[file]
  test("the first of dev, start, serve, preview with the folder's package manager", () => {
    const plan = DevServer.plan(
      "/p",
      files({ "/p/package.json": JSON.stringify({ scripts: { start: "node s.js", dev: "vite" } }), "/p/pnpm-lock.yaml": "" }),
    )
    expect(plan).toMatchObject({ script: "dev", command: ["pnpm", "run", "dev"], display: "pnpm run dev" })
    expect(DevServer.plan("/p", files({ "/p/package.json": JSON.stringify({ scripts: { build: "x" } }) }))).toBeUndefined()
    expect(DevServer.plan("/p", files({}))).toBeUndefined()
  })
  test("the address it prints", () => {
    expect(DevServer.address("\u001b[32m  Local:   http://localhost:5173/\u001b[0m")).toBe("http://localhost:5173/")
    expect(DevServer.address("ready on http://0.0.0.0:3000.")).toBe("http://localhost:3000")
    expect(DevServer.address("listening")).toBeUndefined()
  })
})
