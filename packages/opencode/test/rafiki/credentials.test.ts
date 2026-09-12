// The stored credential: permissions, round trip, and precedence in the brand config.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import * as Credentials from "@opencode-ai/core/brand/credentials"
import { Brand } from "@opencode-ai/core/brand/brand"

let home: string
const saved: Record<string, string | undefined> = {}
const vars = ["XDG_CONFIG_HOME", "OPENCODE_TEST_HOME", Brand.env.apiKey, Brand.env.gatewayURL]

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-cred-"))
  for (const v of vars) {
    saved[v] = process.env[v]
    delete process.env[v]
  }
  process.env["OPENCODE_TEST_HOME"] = home
})

afterEach(() => {
  for (const v of vars) {
    if (saved[v] === undefined) delete process.env[v]
    else process.env[v] = saved[v]
  }
  fs.rmSync(home, { recursive: true, force: true })
})

const sample: Credentials.StoredCredential = {
  version: 1,
  key: "sk-test-not-a-real-key",
  key_id: "5d3d8b0e-0000-0000-0000-000000000000",
  key_alias: "rafikicode-1c2a",
  gateway_url: "http://127.0.0.1:4180/v1",
  console_url: "http://127.0.0.1:4181",
  owner: { id: "usr_1", email: "jane@example.com", name: "Jane" },
  expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  created_at: new Date().toISOString(),
}

describe("credentials store", () => {
  test("writes with 0600 file and 0700 directory permissions", () => {
    const dir = Brand.configDir()
    expect(dir).toBe(path.join(home, ".rafikicode"))
    Credentials.write(dir, sample)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(Credentials.file(dir)).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(Credentials.file(dir) + ".tmp")).toBe(false)
  })

  test("tightens an existing directory to 0700", () => {
    const dir = Brand.configDir()
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    Credentials.write(dir, sample)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  })

  test("round trips and rejects junk", () => {
    const dir = Brand.configDir()
    expect(Credentials.read(dir)).toBeUndefined()
    Credentials.write(dir, sample)
    expect(Credentials.read(dir)).toEqual(sample)
    fs.writeFileSync(Credentials.file(dir), "{not json")
    expect(Credentials.read(dir)).toBeUndefined()
    fs.writeFileSync(Credentials.file(dir), JSON.stringify({ version: 2, key: "x" }))
    expect(Credentials.read(dir)).toBeUndefined()
    expect(Credentials.remove(dir)).toBe(true)
    expect(Credentials.remove(dir)).toBe(false)
    expect(Credentials.exists(dir)).toBe(false)
  })

  test("warns once about a credential file readable by others and still reads it", () => {
    const dir = Brand.configDir()
    Credentials.write(dir, sample)
    const warnings: string[] = []
    const previous = Credentials.warn
    Credentials.setWarn((m) => warnings.push(m))
    try {
      expect(Credentials.read(dir)).toEqual(sample)
      expect(warnings).toEqual([])
      fs.chmodSync(Credentials.file(dir), 0o644)
      expect(Credentials.read(dir)).toEqual(sample)
      expect(Credentials.read(dir)).toEqual(sample)
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toContain("readable by other users")
      expect(warnings[0]).toContain("mode 0644")
      expect(warnings[0]).toContain(`chmod 600 ${Credentials.file(dir)}`)
      expect(warnings[0]).not.toContain(sample.key)
    } finally {
      Credentials.setWarn(previous)
    }
  })

  test("stored login wires the provider with its key and gateway URL", () => {
    expect(Brand.hasKey()).toBe(false)
    expect(Brand.config().provider).toBeUndefined()
    Credentials.write(Brand.configDir(), sample)
    expect(Brand.hasKey()).toBe(true)
    const provider = Brand.config().provider!.rafiki
    expect(provider.options.baseURL).toBe("http://127.0.0.1:4180/v1")
    expect(provider.options.apiKey).toBe(sample.key)
    expect(Brand.gatewayURL()).toBe("http://127.0.0.1:4180/v1")
  })

  test("the env var wins over the stored login", () => {
    Credentials.write(Brand.configDir(), sample)
    process.env[Brand.env.apiKey] = "sk-env"
    const provider = Brand.config().provider!.rafiki
    expect(provider.options.apiKey).toBeUndefined()
    expect(provider.env).toEqual([Brand.env.apiKey])
    process.env[Brand.env.gatewayURL] = "http://127.0.0.1:4189/v1"
    expect(Brand.gatewayURL()).toBe("http://127.0.0.1:4189/v1")
  })
})
