// The cap on one tool result (src/rafiki/tool-output.ts, tool/truncate.ts,
// tool/shell.ts): a result over about 8,000 tokens is written to a file in the
// session's folder, and the model gets the head, the tail, the counts and the
// path. And the start of every request stays the same during a session, even
// when AGENTS.md is edited (rafiki/cache-prefix.ts instructions).
//
// The end to end test runs `rafikicode run` against the mock gateway: the
// first answer asks for a shell command that prints 40,000 lines and appends
// a line to AGENTS.md, the second answer is text. The second request is
// compared with the first as the gateway received it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { filesystem } from "@opencode-ai/core/effect/app-node-platform"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Brand } from "@opencode-ai/core/brand/brand"
import { Truncate } from "@/tool/truncate"
import { Token } from "@/util/token"
import * as ToolOutput from "../../src/rafiki/tool-output"
import * as CachePrefix from "../../src/rafiki/cache-prefix"
import { testEffect } from "../lib/effect"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n")

describe("head and tail", () => {
  test("the cap is about 8,000 tokens", () => {
    expect(ToolOutput.CAP_BYTES).toBe(32 * 1024)
    expect(Truncate.MAX_BYTES).toBe(ToolOutput.CAP_BYTES)
    expect(Truncate.MAX_LINES).toBe(2000)
  })

  test("many lines: half of the line budget at each end, the left out range and the counts", () => {
    const cut = ToolOutput.cut(numbered(100), { maxLines: 10, maxBytes: 100_000 })
    expect(cut.head.text).toBe(numbered(5))
    expect(cut.tail.text).toBe(Array.from({ length: 5 }, (_, i) => `line ${96 + i}`).join("\n"))
    expect(cut.lines).toBe(100)
    expect(cut.omittedLines).toBe(90)
    expect([cut.from, cut.to]).toEqual([6, 95])
    expect(cut.byBytes).toBe(false)
    const text = ToolOutput.compose({ cut, file: "/data/tool-output/ses_a/tool_1", delegate: false })
    expect(text).toContain("...90 lines truncated...")
    expect(text).toContain(`The output has 100 lines (${ToolOutput.count(Buffer.byteLength(numbered(100)))} bytes); lines 6 to 95 are not shown in full.`)
    expect(text).toContain("Full output saved to: /data/tool-output/ses_a/tool_1")
    expect(text).toContain("Read with offset/limit")
    expect(text.startsWith("line 1\n")).toBe(true)
    expect(text.endsWith("line 100")).toBe(true)
  })

  test("just over the limit: the tail starts after the head, nothing is shown twice", () => {
    const cut = ToolOutput.cut(numbered(11), { maxLines: 10, maxBytes: 100_000 })
    expect(cut.head.lines + cut.tail.lines).toBe(10)
    expect(cut.omittedLines).toBe(1)
    expect([cut.from, cut.to]).toEqual([6, 6])
    expect(cut.tail.text.split("\n")[0]).toBe("line 7")
  })

  test("long lines: the byte budget decides, split between the two ends", () => {
    const text = numbered(5000)
    const cut = ToolOutput.cut(text, { maxLines: 2000, maxBytes: 4096 })
    expect(cut.byBytes).toBe(true)
    expect(cut.head.bytes).toBeLessThanOrEqual(2048)
    expect(cut.tail.bytes).toBeLessThanOrEqual(2048)
    expect(cut.head.text.startsWith("line 1\n")).toBe(true)
    expect(cut.tail.text.endsWith("line 5000")).toBe(true)
    expect(cut.omittedBytes).toBe(Buffer.byteLength(text) - cut.head.bytes - cut.tail.bytes - 2)
  })

  test("one very long line: its start and its end, cut on character boundaries", () => {
    const text = "é".repeat(30_000)
    const cut = ToolOutput.cut(text, { maxLines: 2000, maxBytes: 1001 })
    expect(cut.head.partial && cut.tail.partial).toBe(true)
    expect(cut.head.text).toBe("é".repeat(250))
    expect(cut.tail.text).toBe("é".repeat(250))
    expect(cut.omittedBytes).toBe(60_000 - 1000)
    const notice = ToolOutput.notice({ cut, file: "/f", delegate: true })
    expect(notice).toContain("...59,000 bytes truncated...")
    expect(notice).toContain("one line of 60,000 bytes")
    expect(notice).toContain("Task tool")
  })

  test("the text for a capped result is the same bytes every time", () => {
    const cut = () => ToolOutput.cut(numbered(9000), { maxLines: 2000, maxBytes: ToolOutput.CAP_BYTES })
    expect(ToolOutput.compose({ cut: cut(), file: "/f", delegate: false })).toBe(
      ToolOutput.compose({ cut: cut(), file: "/f", delegate: false }),
    )
  })
})

const it = testEffect(LayerNode.compile(LayerNode.group([Truncate.node, FSUtil.node, filesystem])))

describe("Truncate with a session", () => {
  it.live("a 200 KB result: the file in the session's folder, under 8,500 tokens sent", () =>
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      const fsys = yield* FSUtil.Service
      const text = Array.from({ length: 4000 }, (_, i) => `${String(i + 1).padStart(5, "0")} ${"x".repeat(45)}`).join("\n")
      expect(Buffer.byteLength(text)).toBeGreaterThan(200_000)
      const result = yield* svc.output(text, { sessionID: "ses_toolcap0test" })
      expect(result.truncated).toBe(true)
      if (!result.truncated) throw new Error("expected truncated")
      expect(path.dirname(result.outputPath)).toBe(path.join(Truncate.DIR, "ses_toolcap0test"))
      expect(yield* fsys.readFileString(result.outputPath)).toBe(text)
      expect(Token.estimate(result.content)).toBeLessThan(8_500)
      expect(result.content.startsWith("00001 ")).toBe(true)
      expect(result.content.endsWith("04000 " + "x".repeat(45))).toBe(true)
      expect(result.content).toContain("The output has 4,000 lines")
      expect(result.content).toContain(`Full output saved to: ${result.outputPath}`)
      fs.rmSync(path.dirname(result.outputPath), { recursive: true, force: true })
    }),
  )

  it.live("an unusable session id falls back to the shared folder", () =>
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      const result = yield* svc.output(numbered(3000), { sessionID: "../escape" })
      if (!result.truncated) throw new Error("expected truncated")
      expect(path.dirname(result.outputPath)).toBe(Truncate.DIR)
      fs.rmSync(result.outputPath, { force: true })
    }),
  )
})

describe("project instructions in the prefix", () => {
  test("the first reading of a session is kept until it is refreshed", () => {
    expect(CachePrefix.instructions("ses_one", ["a"])).toEqual(["a"])
    expect(CachePrefix.instructions("ses_one", ["a", "edited"])).toEqual(["a"])
    expect(CachePrefix.instructions("ses_two", ["b"])).toEqual(["b"])
    CachePrefix.refresh("ses_one")
    expect(CachePrefix.instructions("ses_one", ["a", "edited"])).toEqual(["a", "edited"])
  })
})

describe("one task against the mock gateway", () => {
  let home: string
  let repo: string
  let gateway: ReturnType<typeof createMockGateway>
  const RULE = "Project rule for the tool output test."

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-tool-output-"))
    repo = path.join(home, "repo")
    fs.mkdirSync(repo)
    spawnSync("git", ["init", "-q"], { cwd: repo })
    fs.writeFileSync(path.join(repo, "AGENTS.md"), `# Project instructions\n\n${RULE}\n`)
    gateway = createMockGateway({
      quiet: true,
      bodies: true,
      toolCall: {
        name: "bash",
        arguments: { command: "echo 'Rule added during the session.' >> AGENTS.md; seq 1 40000", description: "Print many lines" },
      },
    })
    await gateway.ready
  })

  afterEach(async () => {
    await gateway.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  test("a 40,000 line command output is capped, and the prefix does not change when AGENTS.md does", async () => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      PWD: repo,
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      RAFIKICODE_GATEWAY_URL: gateway.url + "/v1",
      RAFIKICODE_API_KEY: "sk-tool-output-stub",
    }
    for (const k of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION", Brand.env.headless, Brand.env.trustWorkspace])
      delete env[k]
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), "run", "--model", "rafiki/rafiki-fast", "Print many lines with the shell, then stop."], {
      cwd: repo,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env as Record<string, string>,
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    expect(await proc.exited, stdout + stderr).toBe(0)
    expect(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8")).toContain("Rule added during the session.")

    const task = (gateway.bodies as any[]).filter((body) => Array.isArray(body.json.tools) && body.json.tools.length > 0)
    expect(task.length).toBe(2)
    const [first, second] = task
    // The stable system message is the same bytes, and still the first reading of AGENTS.md.
    expect(second.json.messages[0].content).toBe(first.json.messages[0].content)
    expect(first.json.messages[0].content).toContain(RULE)
    expect(second.json.messages[0].content).not.toContain("Rule added during the session.")

    // The tool result: head, tail, counts and the file in the session's folder.
    const tool = second.json.messages.find((message: any) => message.role === "tool")
    const content = typeof tool.content === "string" ? tool.content : JSON.stringify(tool.content)
    expect(Token.estimate(content)).toBeLessThan(8_500)
    expect(content).toContain("The output has 40,000 lines")
    expect(content).toContain("1\n2\n3\n")
    expect(content).toContain("39999\n40000")
    const saved = content.match(/Full output saved to: (\S+)/)?.[1]
    expect(saved).toBeDefined()
    expect(saved!).toContain(path.join("tool-output", second.session))
    const lines = fs.readFileSync(saved!, "utf8").trim().split("\n")
    expect(lines.length).toBe(40_000)
    expect(lines[39_999]).toBe("40000")
  }, 180_000)
})
