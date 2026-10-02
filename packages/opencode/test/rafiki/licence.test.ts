// The licence text compiled into the binary is the repository's own LICENSE
// and NOTICE, whole, and `rafikicode licenses` prints it.
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Licence } from "../../src/rafiki/licence"

const root = path.resolve(import.meta.dir, "../../../..")

describe("the embedded licence", () => {
  test("is the repository's LICENSE and NOTICE, byte for byte", async () => {
    expect(Licence.license).toBe(await fs.readFile(path.join(root, "LICENSE"), "utf8"))
    expect(Licence.notice).toBe(await fs.readFile(path.join(root, "NOTICE"), "utf8"))
  })

  test("carries the copyright line and the permission notice the MIT licence asks for", () => {
    const text = Licence.text()
    expect(text).toContain("MIT License")
    expect(text).toMatch(/Copyright \(c\) \d{4}/)
    expect(text).toContain("Permission is hereby granted, free of charge")
    expect(text).toContain("The above copyright notice and this permission notice shall be included")
  })

  test("rafikicode licenses prints it and needs no sign-in", async () => {
    // A home of its own, so the command reads and writes nothing of this machine's.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "rafikicode-licence-test-"))
    try {
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: home,
        OPENCODE_TEST_HOME: home,
        XDG_DATA_HOME: path.join(home, ".local/share"),
        XDG_STATE_HOME: path.join(home, ".local/state"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        RAFIKICODE_API_KEY: "",
      }
      delete env["XDG_CONFIG_HOME"]
      const proc = Bun.spawn(["bun", "run", path.join(root, "packages/opencode/src/index.ts"), "licenses"], {
        cwd: home,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: env as Record<string, string>,
      })
      const stdout = await new Response(proc.stdout).text()
      expect(await proc.exited).toBe(0)
      expect(stdout).toBe(Licence.text())
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  }, 60_000)
})
