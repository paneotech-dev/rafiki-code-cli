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
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([])
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

  test("refuses a credential file readable by group or others and names the chmod fix", () => {
    const dir = Brand.configDir()
    Credentials.write(dir, sample)
    expect(Credentials.check(dir)).toBeUndefined()
    expect(Credentials.read(dir)).toEqual(sample)
    for (const mode of [0o640, 0o604, 0o644, 0o660]) {
      fs.chmodSync(Credentials.file(dir), mode)
      const problem = Credentials.check(dir)
      expect(problem).toBeInstanceOf(Credentials.UnsafeCredentialError)
      expect(problem!.exitCode).toBe(2)
      expect(problem!.message).toContain(`mode ${mode.toString(8).padStart(4, "0")}`)
      expect(problem!.message).toContain(`chmod 600 ${Credentials.file(dir)}`)
      expect(problem!.message).not.toContain(sample.key)
      expect(() => Credentials.read(dir)).toThrow(Credentials.UnsafeCredentialError)
      expect(() => Brand.credential()).toThrow(Credentials.UnsafeCredentialError)
      expect(Brand.unsafeCredential()?.fix).toBe(`chmod 600 ${Credentials.file(dir)}`)
      // Never trusted for its gateway URL either.
      expect(Brand.gatewayURL()).toBe(Brand.gateway.url)
    }
    fs.chmodSync(Credentials.file(dir), 0o600)
    expect(Credentials.read(dir)).toEqual(sample)
  })

  test("refuses a credential file that is a symbolic link", () => {
    const dir = Brand.configDir()
    const elsewhere = path.join(home, "elsewhere")
    Credentials.write(elsewhere, sample)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.symlinkSync(Credentials.file(elsewhere), Credentials.file(dir))
    expect(Credentials.exists(dir)).toBe(true)
    expect(Credentials.check(dir)?.reason).toBe("is a symbolic link")
    expect(Credentials.check(dir)?.fix).toContain(`rm ${Credentials.file(dir)}`)
    expect(() => Credentials.read(dir)).toThrow("is a symbolic link")
    // A dangling link is refused the same way.
    fs.rmSync(Credentials.file(elsewhere))
    expect(Credentials.exists(dir)).toBe(true)
    expect(() => Credentials.read(dir)).toThrow("is a symbolic link")
  })

  test("refuses a credential file owned by another user", () => {
    const dir = Brand.configDir()
    Credentials.write(dir, sample)
    const other = (process.getuid?.() ?? 0) + 1
    const problem = Credentials.check(dir, other)
    expect(problem?.reason).toContain("belongs to another user")
    expect(problem?.fix).toBe(`chown ${other} ${Credentials.file(dir)} && chmod 600 ${Credentials.file(dir)}`)
    expect(() => Credentials.read(dir, other)).toThrow(Credentials.UnsafeCredentialError)
  })

  test("RAFIKICODE_API_KEY still works next to an unsafe credential file", () => {
    Credentials.write(Brand.configDir(), sample)
    fs.chmodSync(Credentials.file(Brand.configDir()), 0o644)
    process.env[Brand.env.apiKey] = "sk-env-still-works"
    expect(Brand.unsafeCredential()).toBeUndefined()
    expect(Brand.credential()).toBeUndefined()
    const provider = Brand.config().provider!.rafiki
    expect(provider.env).toEqual([Brand.env.apiKey])
    expect(provider.options.apiKey).toBeUndefined()
    expect(provider.options.baseURL).toBe(Brand.gateway.url)
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

describe("an unsafe credential file at the command line", () => {
  const root = path.resolve(import.meta.dir, "../..")

  async function run(args: string[], extra: Record<string, string> = {}) {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      ...extra,
    }
    for (const k of ["XDG_CONFIG_HOME", "CI", "GITHUB_ACTIONS"]) delete env[k]
    if (!extra[Brand.env.apiKey]) delete env[Brand.env.apiKey]
    const proc = Bun.spawn(["bun", "run", path.join(root, "src/index.ts"), ...args], {
      cwd: home,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: env as Record<string, string>,
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    return { exitCode: await proc.exited, stdout, stderr }
  }

  test("stops with exit 2 and the chmod fix; the env key still works; logout removes it", async () => {
    const dir = Brand.configDir()
    Credentials.write(dir, sample)
    fs.chmodSync(Credentials.file(dir), 0o644)

    const refused = await run(["models", "rafiki"])
    expect(refused.exitCode).toBe(2)
    expect(refused.stderr).toContain(`The credential file ${Credentials.file(dir)} can be read or written by other users (mode 0644), so it is not used.`)
    expect(refused.stderr).toContain(`chmod 600 ${Credentials.file(dir)}`)
    expect(refused.stderr).toContain(Brand.env.apiKey)
    expect(refused.stdout + refused.stderr).not.toContain(sample.key)

    const withEnv = await run(["models", "rafiki"], { [Brand.env.apiKey]: "sk-env-still-works" })
    expect(withEnv.exitCode).toBe(0)
    expect(withEnv.stdout).toContain("rafiki/rafiki-fast")

    const out = await run(["logout"])
    expect(out.exitCode).toBe(0)
    expect(out.stdout + out.stderr).toContain("without revoking its key")
    expect(fs.existsSync(Credentials.file(dir))).toBe(false)
  }, 120_000)
})

describe("credential directory other users can write (F7)", () => {
  test.skipIf(process.platform === "win32")("a credential in a directory other users can write is refused with the chmod 700 fix", () => {
    const dir = Brand.configDir()
    Credentials.write(dir, sample)
    for (const mode of [0o777, 0o770, 0o702]) {
      fs.chmodSync(dir, mode)
      const problem = Credentials.check(dir)
      expect(problem?.reason).toBe(`can be changed by other users (mode ${mode.toString(8).padStart(4, "0")})`)
      expect(problem?.fix).toBe(`chmod 700 ${dir}`)
      expect(() => Credentials.read(dir)).toThrow(Credentials.UnsafeCredentialError)
      expect(() => Credentials.read(dir)).toThrow(/can be changed by other users/)
    }
    fs.chmodSync(dir, 0o755)
    expect(Credentials.check(dir)).toBeUndefined()
    expect(Credentials.read(dir)).toEqual(sample)
  })

  test.skipIf(process.platform === "win32")("without a credential file such a directory is simply signed out", () => {
    const dir = Brand.configDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.chmodSync(dir, 0o777)
    expect(Credentials.check(dir)).toBeUndefined()
    expect(Credentials.read(dir)).toBeUndefined()
  })

  test.skipIf(process.platform === "win32")("signing in tightens an own directory other users could write to 0700", () => {
    const dir = Brand.configDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.chmodSync(dir, 0o775)
    Credentials.write(dir, sample)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(Credentials.read(dir)).toEqual(sample)
  })
})

describe("credential write (B4)", () => {
  test.skipIf(process.platform === "win32")("does not follow a planted credentials.tmp link and leaves no temp file", () => {
    const dir = Brand.configDir()
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const victim = path.join(home, "victim.txt")
    fs.writeFileSync(victim, "untouched\n")
    fs.symlinkSync(victim, Credentials.file(dir) + ".tmp")
    Credentials.write(dir, sample)
    expect(fs.readFileSync(victim, "utf8")).toBe("untouched\n")
    expect(Credentials.read(dir)?.key).toBe(sample.key)
    expect(fs.lstatSync(Credentials.file(dir)).isFile()).toBe(true)
    expect(fs.statSync(Credentials.file(dir)).mode & 0o777).toBe(0o600)
    // The planted link is left alone; no temp file of ours remains.
    expect(fs.readdirSync(dir).sort()).toEqual(["credentials", "credentials.tmp"])
  })

  test.skipIf(process.platform === "win32")("refuses a config directory that is a symbolic link", () => {
    const elsewhere = path.join(home, "elsewhere")
    fs.mkdirSync(elsewhere, { mode: 0o755 })
    const dir = Brand.configDir()
    fs.symlinkSync(elsewhere, dir)
    expect(() => Credentials.write(dir, sample)).toThrow(Credentials.UnsafeCredentialError)
    expect(() => Credentials.write(dir, sample)).toThrow(/is a symbolic link/)
    expect(fs.readdirSync(elsewhere)).toEqual([])
    expect(fs.statSync(elsewhere).mode & 0o777).toBe(0o755)
  })

  test.skipIf(process.platform === "win32")("refuses a config directory owned by another user", () => {
    const dir = Brand.configDir()
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const other = (process.getuid?.() ?? 0) + 1
    expect(Credentials.checkDir(dir, other)?.message).toContain(`belongs to another user`)
    expect(() => Credentials.write(dir, sample, other)).toThrow(Credentials.UnsafeCredentialError)
    expect(fs.readdirSync(dir)).toEqual([])
    expect(Credentials.checkDir(dir)).toBeUndefined()
  })

  test("each write uses a fresh temp name, so a leftover temp file does not block it", () => {
    const dir = Brand.configDir()
    Credentials.write(dir, sample)
    fs.writeFileSync(Credentials.file(dir) + ".0000000000000000.tmp", "stale", { mode: 0o600 })
    Credentials.write(dir, { ...sample, key_alias: "second" })
    expect(Credentials.read(dir)?.key_alias).toBe("second")
  })
})
