// Output piped to a slow reader is complete: the process waits for the pipe
// to take everything before it exits (rafiki/drain.ts). Before, a long
// session exported into a pipe was cut at a 64 KiB boundary.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { createMockGateway } from "../brand/mock-gateway.mjs"

const root = path.resolve(import.meta.dir, "../..")
// Far more than a pipe holds (64 KiB on Linux).
const WORDS = 60_000
const reply = Array.from({ length: WORDS }, (_, i) => `w${i}`).join(" ")

// Pipes the command into a reader that only starts reading after a pause, so
// the pipe fills while the command is still writing, and returns what the
// reader got. (Bun.spawn's own pipe reads eagerly, so it would hide the bug.)
async function slowRead(command: string[], env: Record<string, string>, cwd: string, out: string) {
  const quoted = command.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ")
  const proc = Bun.spawn(["sh", "-c", `${quoted} 2>/dev/null < /dev/null | (sleep 2; cat > '${out}')`], {
    cwd,
    env,
    stdout: "ignore",
    stderr: "ignore",
  })
  await proc.exited
  return fs.readFileSync(out, "utf8")
}

describe("output piped to a slow reader", () => {
  let home: string
  let repo: string
  let gateway: ReturnType<typeof createMockGateway>

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-drain-"))
    repo = path.join(home, "repo")
    fs.mkdirSync(repo)
    gateway = createMockGateway({ quiet: true, reply })
    await gateway.ready
  })

  afterEach(async () => {
    await gateway.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  function env() {
    const value: Record<string, string | undefined> = {
      ...process.env,
      COLUMNS: "120",
      PWD: repo,
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      RAFIKICODE_GATEWAY_URL: gateway.url + "/v1",
      RAFIKICODE_API_KEY: "sk-drain-stub",
    }
    // The test preload keeps the database in memory and turns experimental systems on; a person's run has neither.
    for (const name of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_EXPERIMENTAL_EVENT_SYSTEM", "OPENCODE_EXPERIMENTAL_WORKSPACES", "OPENCODE_DB"])
      delete value[name]
    return value as Record<string, string>
  }

  const cli = (...args: string[]) => [process.execPath, "run", path.join(root, "src/index.ts"), ...args]

  test("run --format json and export of a long session reach the reader in full", async () => {
    const run = await slowRead(cli("run", "--format", "json", "write a lot"), env(), repo, path.join(home, "run.out"))
    expect(run.length).toBeGreaterThan(256 * 1024)
    const events = run.trim().split("\n").map((line) => JSON.parse(line))
    const text = events.find((event) => event.type === "text")
    expect(text.part.text.trim().endsWith(`w${WORDS - 1}`)).toBe(true)

    const exported = await slowRead(cli("export", events[0].sessionID), env(), repo, path.join(home, "export.out"))
    expect(exported.length).toBeGreaterThan(256 * 1024)
    const data = JSON.parse(exported.slice(exported.indexOf("{")))
    expect(data.info.id).toBe(events[0].sessionID)
    expect(JSON.stringify(data.messages)).toContain(`w${WORDS - 1}`)
  }, 120_000)
})
