// The licence text compiled into the binary is the repository's own LICENSE
// and NOTICE, whole, and `rafikicode licenses` prints it.
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
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
    const proc = Bun.spawn(["bun", "run", path.join(root, "packages/opencode/src/index.ts"), "licenses"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1", RAFIKICODE_API_KEY: "" },
    })
    const stdout = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    expect(stdout).toBe(Licence.text())
  }, 60_000)
})
