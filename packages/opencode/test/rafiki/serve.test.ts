// rafikicode serve, web, acp and the terminal interface server (L-R2-8): the
// server answers with the configuration, which carries the stored key, so an
// address other machines can reach needs OPENCODE_SERVER_PASSWORD, and a
// loopback server without one gets a warning.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import * as Serve from "@opencode-ai/core/brand/serve"

const root = path.resolve(import.meta.dir, "../..")
const home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-serve-"))

afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

describe("server password rule", () => {
  test("only 127.0.0.0/8, ::1 and localhost count as loopback", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"]) expect(Serve.loopback(host), host).toBe(true)
    for (const host of ["0.0.0.0", "::", "[::]", "", "192.168.1.10", "10.0.0.1", "127.0.0.1.nip.io", "127.0.0.256", "localhost.example.com", "example.com"]) {
      expect(Serve.loopback(host), host).toBe(false)
    }
  })

  test("another address without a password is refused, loopback warns, a password is enough", () => {
    expect(Serve.check({ hostname: "0.0.0.0" }).refuse).toContain("Refusing to listen on 0.0.0.0 without a password")
    expect(Serve.check({ hostname: "192.168.1.10", password: "" }).refuse).toContain("Set OPENCODE_SERVER_PASSWORD")
    expect(Serve.check({ hostname: "" }).refuse).toContain("every address")
    const loop = Serve.check({ hostname: "127.0.0.1" })
    expect(loop.refuse).toBeUndefined()
    expect(loop.warn).toContain("OPENCODE_SERVER_PASSWORD is not set")
    expect(Serve.check({ hostname: "0.0.0.0", password: "stub-password" })).toEqual({})
    expect(Serve.check({ hostname: "127.0.0.1", password: "stub-password" })).toEqual({})
  })

  test("refused() prints the refusal and sets the usage exit code", () => {
    const saved = { code: process.exitCode, password: process.env[Serve.passwordEnv] }
    const lines: string[] = []
    try {
      delete process.env[Serve.passwordEnv]
      expect(Serve.refused({ hostname: "127.0.0.1" }, (l) => lines.push(l))).toBe(false)
      expect(Serve.refused({ hostname: "0.0.0.0" }, (l) => lines.push(l))).toBe(true)
      expect(process.exitCode).toBe(2)
      process.env[Serve.passwordEnv] = "stub-password"
      expect(Serve.refused({ hostname: "0.0.0.0" }, (l) => lines.push(l))).toBe(false)
      expect(lines.length).toBe(2)
    } finally {
      process.exitCode = saved.code ?? 0
      if (saved.password === undefined) delete process.env[Serve.passwordEnv]
      else process.env[Serve.passwordEnv] = saved.password
    }
  })

  for (const args of [["serve", "--hostname", "0.0.0.0"], ["serve", "--mdns"], ["web", "--hostname", "0.0.0.0"], ["acp", "--hostname", "0.0.0.0"]]) {
    test(`rafikicode ${args.join(" ")} without a password exits 2 before listening`, async () => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: home,
        OPENCODE_TEST_HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local/share"),
        XDG_STATE_HOME: path.join(home, ".local/state"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
      }
      delete env[Serve.passwordEnv]
      // A port inside the project range; nothing listens on it when the rule holds.
      const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), ...args, "--port", "4114"], {
        cwd: home,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: env as Record<string, string>,
      })
      const timer = setTimeout(() => proc.kill(), 45_000)
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      const exitCode = await proc.exited
      clearTimeout(timer)
      expect(exitCode).toBe(2)
      expect(stderr).toContain("without a password")
      expect(stdout).not.toContain("listening on")
    }, 60_000)
  }
})
