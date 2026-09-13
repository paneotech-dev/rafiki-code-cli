// The core config service's plugin loader and workspace trust: plugin files in
// an untrusted project directory, and plugin entries in an untrusted project
// document, are not imported (brand/trust.ts). The loader imports in a forked
// fiber, so each case waits for the marker a loaded plugin writes.
import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import * as BrandTrust from "@opencode-ai/core/brand/trust"
import { Config } from "@opencode-ai/core/config"
import { ConfigExternalPlugin } from "@opencode-ai/core/config/plugin/external"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { Npm } from "@opencode-ai/core/npm"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)
const decode = Schema.decodeUnknownSync(Config.Info)
const trustEnv = "RAFIKICODE_TRUST_WORKSPACE"

let saved: string | undefined
let dir: string
let warnings: string[]
let restoreWarn: (m: string) => void

function plugin(name: string) {
  const file = path.join(dir, ".rafikicode", "plugin", `${name}.ts`)
  const marker = path.join(dir, `${name}.loaded`)
  fs.writeFileSync(
    file,
    `import fs from "fs"\nfs.writeFileSync(${JSON.stringify(marker)}, "loaded")\nexport default { id: ${JSON.stringify(name)}, setup: async () => ({}) }\n`,
  )
  return { file, marker }
}

beforeEach(() => {
  saved = process.env[trustEnv]
  delete process.env[trustEnv]
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rafikicode-plugin-trust-")))
  fs.mkdirSync(path.join(dir, ".rafikicode", "plugin"), { recursive: true })
  warnings = []
  BrandTrust.resetWarnings()
  restoreWarn = BrandTrust.setWarn((m) => warnings.push(m))
})

afterEach(() => {
  BrandTrust.setWarn(restoreWarn)
  if (saved === undefined) delete process.env[trustEnv]
  else process.env[trustEnv] = saved
  fs.rmSync(dir, { recursive: true, force: true })
})

const load = (entries: (Config.Directory | Config.Document)[], markers: string[]) =>
  Effect.gen(function* () {
    const plugins = yield* PluginV2.Service
    const host = yield* PluginHost.make(plugins)
    yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
      Effect.provideService(PluginV2.Service, plugins),
      Effect.provideService(FSUtil.Service, yield* FSUtil.Service),
      Effect.provideService(Location.Service, yield* Location.Service),
      Effect.provideService(Npm.Service, yield* Npm.Service),
      Effect.provideService(Config.Service, Config.Service.of({ entries: () => Effect.succeed(entries) })),
    )
    for (let attempt = 0; attempt < 100 && !markers.every((m) => fs.existsSync(m)); attempt++) yield* Effect.sleep("20 millis")
  })

const entries = (document: string) => [
  new Config.Directory({ type: "directory", path: AbsolutePath.make(path.join(dir, ".rafikicode")) }),
  new Config.Document({
    type: "document",
    path: path.join(dir, "rafikicode.json"),
    info: decode({ plugins: [{ package: `./.rafikicode/${document}` }] }),
  }),
]

describe("ConfigExternalPlugin and workspace trust", () => {
  it.live("imports no plugin file or plugin entry from an untrusted project", () =>
    Effect.gen(function* () {
      const scanned = plugin("scanned")
      fs.mkdirSync(path.join(dir, ".rafikicode", "entry"), { recursive: true })
      const declared = plugin("declared")
      fs.renameSync(declared.file, path.join(dir, ".rafikicode", "entry", "declared.ts"))
      yield* load(entries("entry/declared.ts"), [scanned.marker, declared.marker])
      expect(fs.existsSync(scanned.marker)).toBe(false)
      expect(fs.existsSync(declared.marker)).toBe(false)
      const all = warnings.join("\n")
      expect(all).toContain(`not loading 1 project plugin from ${path.join(dir, ".rafikicode")}`)
      expect(all).toContain(`not loading 1 project plugin from ${dir}`)
    }),
  )

  it.live("imports both once the workspace is trusted", () =>
    Effect.gen(function* () {
      process.env[trustEnv] = dir
      const scanned = plugin("scanned")
      fs.mkdirSync(path.join(dir, ".rafikicode", "entry"), { recursive: true })
      const declared = plugin("declared")
      fs.renameSync(declared.file, path.join(dir, ".rafikicode", "entry", "declared.ts"))
      yield* load(entries("entry/declared.ts"), [scanned.marker, declared.marker])
      expect(fs.existsSync(scanned.marker)).toBe(true)
      expect(fs.existsSync(declared.marker)).toBe(true)
      expect(warnings).toEqual([])
    }),
  )
})
