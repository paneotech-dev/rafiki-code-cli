// rafikicode run on a machine whose only way out is the gateway (an evaluation
// container, a locked down server). Every outbound connection goes to a
// recording proxy that refuses it; the mock gateway is reached directly.
//   - A plain run contacts no host but the gateway, apart from the Console
//     (wallet and usage), which is optional and fails without a word: no
//     upstream model catalogue, no package registry.
//   - The grep tool works without ripgrep: the download from GitHub is refused
//     and the built-in search answers, with one line saying so.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import http from "http"
import net from "net"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as SearchFallback from "@opencode-ai/core/brand/search-fallback"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")

// Records the host of every request it is asked to carry and refuses it.
function recordingProxy() {
  const hosts: string[] = []
  const server = http.createServer((req, res) => {
    try {
      hosts.push(new URL(req.url ?? "").hostname)
    } catch {
      hosts.push(String(req.headers.host ?? "unknown"))
    }
    res.writeHead(403)
    res.end("refused by the test proxy")
  })
  server.on("connect", (req, socket: net.Socket) => {
    hosts.push(String(req.url ?? "").replace(/:\d+$/, ""))
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
  })
  const ready = new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`)),
  )
  return { hosts, ready, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

// A PATH with git and sh only, so no ripgrep the machine may have is found.
function bareBin(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  for (const tool of ["git", "sh"]) {
    const found = Bun.which(tool)
    if (found) fs.symlinkSync(found, path.join(dir, tool))
  }
  return dir
}

describe("rafikicode run with only the gateway reachable", () => {
  let home: string
  let repo: string
  let gateway: ReturnType<typeof createMockGateway> | undefined
  let proxy: ReturnType<typeof recordingProxy>

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-offline-"))
    repo = path.join(home, "repo")
    fs.mkdirSync(repo)
    proxy = recordingProxy()
  })

  afterEach(async () => {
    await gateway?.close()
    gateway = undefined
    await proxy.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  async function run(args: string[]) {
    const proxyURL = await proxy.ready
    const env: Record<string, string | undefined> = {
      ...process.env,
      COLUMNS: "120",
      PWD: repo,
      PATH: bareBin(path.join(home, "bin")),
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      RAFIKICODE_GATEWAY_URL: gateway!.url + "/v1",
      RAFIKICODE_API_KEY: "sk-offline-stub",
      HTTP_PROXY: proxyURL,
      HTTPS_PROXY: proxyURL,
      http_proxy: proxyURL,
      https_proxy: proxyURL,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    }
    // The defaults a person gets: nothing that turns a fetch off by hand, and
    // the provider scope of the official build (the test preload opens it).
    for (const name of [
      "OPENCODE_DISABLE_MODELS_FETCH",
      "OPENCODE_DISABLE_AUTOUPDATE",
      "OPENCODE_MODELS_PATH",
      "OPENCODE_MODELS_URL",
      Brand.providers.testEnv,
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_CONFIG_CONTENT",
      "CI",
      "GITHUB_ACTIONS",
      "OPENCODE_EXPERIMENTAL_EVENT_SYSTEM",
      "OPENCODE_EXPERIMENTAL_WORKSPACES",
      "OPENCODE_DB",
      Brand.env.maxOutputTokens,
      Brand.env.reasoningEffort,
    ])
      delete env[name]
    const proc = Bun.spawn([process.execPath, "run", path.join(root, "src/index.ts"), "run", "--auto", ...args], {
      cwd: repo,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { exitCode: await proc.exited, all: stdout + stderr }
  }

  const consoleHost = new URL(Brand.consoleURL()).hostname

  test("a plain run contacts the gateway and nothing else but the optional Console, which fails quietly", async () => {
    gateway = createMockGateway({ quiet: true })
    await gateway.ready
    const result = await run(["say hello"])
    expect(result.exitCode).toBe(0)
    expect(result.all).toContain("Mock gateway reply")
    expect(gateway.requests.some((r: any) => r.path === "/v1/chat/completions")).toBe(true)
    const others = [...new Set(proxy.hosts)].filter((host) => host !== consoleHost)
    expect(others).toEqual([])
    expect(proxy.hosts).not.toContain("models.opencode.ai")
    expect(proxy.hosts).not.toContain("registry.npmjs.org")
    // The refused Console call leaves no error behind.
    expect(result.all).not.toMatch(/error/i)
    expect(result.all).not.toContain(consoleHost)
  }, 120_000)

  test("grep works with ripgrep unreachable: the built-in search answers and one line says so", async () => {
    fs.writeFileSync(path.join(repo, "notes.txt"), "first line\nthe needle_42 is here\nlast line\n")
    fs.mkdirSync(path.join(repo, "sub"))
    fs.writeFileSync(path.join(repo, "sub", "more.md"), "needle_7 in markdown\n")
    gateway = createMockGateway({
      quiet: true,
      bodies: true,
      toolCall: { name: "grep", arguments: { pattern: "needle_[0-9]+", include: "*.txt" } },
    })
    await gateway.ready
    const result = await run(["find the needle"])
    expect(result.exitCode).toBe(0)
    expect(result.all).not.toContain("ripgrep execution failed")
    expect(result.all.split(SearchFallback.NOTICE).length - 1).toBe(1)
    // The tool result the model got back: the match in notes.txt, not the markdown file the include leaves out.
    const sent = JSON.stringify(gateway.bodies.at(-1)!.json.messages)
    expect(sent).toContain("Found 1 matches")
    expect(sent).toContain("needle_42")
    expect(sent).not.toContain("needle_7")
    // The ripgrep download was tried once and refused; nothing else but the Console.
    const others = [...new Set(proxy.hosts)].filter((host) => host !== consoleHost && host !== "github.com")
    expect(others).toEqual([])
  }, 120_000)
})

describe("the built-in search", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-search-"))
    fs.mkdirSync(path.join(dir, "src/deep"), { recursive: true })
    fs.mkdirSync(path.join(dir, "node_modules/pkg"), { recursive: true })
    fs.mkdirSync(path.join(dir, ".git"))
    fs.writeFileSync(path.join(dir, "src/a.ts"), "export const alpha = 1\nconst beta = alpha + 1\n")
    fs.writeFileSync(path.join(dir, "src/deep/b.tsx"), "function alpha() {}\n")
    fs.writeFileSync(path.join(dir, "node_modules/pkg/index.js"), "alpha\n")
    fs.writeFileSync(path.join(dir, ".git/config"), "alpha\n")
    fs.writeFileSync(path.join(dir, ".env"), "ALPHA=1\n")
    fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([0x61, 0x6c, 0x70, 0x68, 0x61, 0x00, 0x01]))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  test("globs read the way ripgrep reads them", () => {
    expect(SearchFallback.globMatcher("*.ts")("src/a.ts")).toBe(true)
    expect(SearchFallback.globMatcher("*.{ts,tsx}")("src/deep/b.tsx")).toBe(true)
    expect(SearchFallback.globMatcher("src/*.ts")("src/a.ts")).toBe(true)
    expect(SearchFallback.globMatcher("src/*.ts")("src/deep/b.ts")).toBe(false)
    expect(SearchFallback.globMatcher("src/**/*.tsx")("src/deep/b.tsx")).toBe(true)
    expect(SearchFallback.globMatcher("**/*.tsx")("b.tsx")).toBe(true)
    expect(SearchFallback.globMatcher("!*.ts")("src/a.ts")).toBe(false)
  })

  test("lists files without .git and node_modules, hidden files only when asked", () => {
    expect(SearchFallback.files(dir, { limit: 100 })).toEqual(["bin.dat", "src/a.ts", "src/deep/b.tsx"])
    expect(SearchFallback.files(dir, { limit: 100, hidden: true })).toContain(".env")
    expect(SearchFallback.files(dir, { limit: 100, glob: "*.tsx" })).toEqual(["src/deep/b.tsx"])
    expect(SearchFallback.files(dir, { limit: 1 })).toHaveLength(1)
  })

  test("grep gives ripgrep's match records, skips binary files, and refuses a broken pattern", () => {
    const matches = SearchFallback.grep(dir, { pattern: "alpha", limit: 100 })
    expect(matches.map((m) => `${m.path.text}:${m.line_number}`)).toEqual(["src/a.ts:1", "src/a.ts:2", "src/deep/b.tsx:1"])
    expect(matches[1]).toMatchObject({
      lines: { text: "const beta = alpha + 1\n" },
      absolute_offset: "export const alpha = 1\n".length,
      submatches: [{ match: { text: "alpha" }, start: 13, end: 18 }],
    })
    expect(SearchFallback.grep(dir, { pattern: "alpha", include: "*.tsx", limit: 100 })).toHaveLength(1)
    expect(SearchFallback.grep(dir, { pattern: "alpha", file: "src/a.ts", limit: 100 })).toHaveLength(2)
    expect(SearchFallback.grep(dir, { pattern: "ALPHA", limit: 100 }).map((m) => m.path.text)).toEqual([".env"])
    expect(SearchFallback.grep(dir, { pattern: "alpha", limit: 1 })).toHaveLength(2)
    expect(() => SearchFallback.grep(dir, { pattern: "(unclosed", limit: 10 })).toThrow(SearchFallback.InvalidPattern)
  })
})
