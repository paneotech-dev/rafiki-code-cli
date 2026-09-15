import { afterAll, beforeAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import { Brand } from "@opencode-ai/core/brand/brand"
import { RafikiUpdate } from "../../src/rafiki/update"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(
  handler: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string } = () =>
    "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

// The release lookup and the curl upgrade go through the Rafiki updater
// (src/rafiki/update.ts), which uses fetch rather than the Effect HttpClient, so
// that every redirect hop is checked. fetch is stubbed for this whole file:
// each test answers the brand's release URLs, and any other request fails the
// test instead of reaching the network.
const RELEASE_API = "https://api.github.com/repos/paneotech-dev/rafiki-code-cli"
const RELEASE_DOWNLOAD = "https://github.com/paneotech-dev/rafiki-code-cli/releases/download"
const RELEASE_ENV = [Brand.env.releaseAPI, Brand.env.releaseBase, Brand.env.allowHttpLoopback]
let release: (url: string) => Response | undefined = () => undefined
const fetched: string[] = []
const realFetch = globalThis.fetch
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const name of RELEASE_ENV) {
    savedEnv[name] = process.env[name]
    delete process.env[name]
  }
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    fetched.push(url)
    const response = release(url)
    if (!response) throw new Error(`unexpected network request in installation tests: ${url}`)
    return response
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  for (const name of RELEASE_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
})

beforeEach(() => {
  release = () => undefined
  fetched.length = 0
})

// For tests whose lookups must not use the Effect HttpClient at all.
function noHttp(calls: string[]) {
  return (request: HttpClientRequest.HttpClientRequest) => {
    calls.push(request.url)
    return new Response("unexpected", { status: 500 })
  }
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string },
) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(spawnHandler),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttpClient(httpHandler)],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

describe("installation", () => {
  describe("latest", () => {
    const githubHttp: string[] = []
    testEffect(testLayer(noHttp(githubHttp))).effect("reads release version from GitHub releases", () =>
      Effect.gen(function* () {
        release = (url) => (url === `${RELEASE_API}/releases/latest` ? jsonResponse({ tag_name: "v1.2.3" }) : undefined)
        const result = yield* Installation.use.latest("unknown")
        expect(result).toBe("1.2.3")
        expect(fetched).toEqual([`${RELEASE_API}/releases/latest`])
        expect(githubHttp).toEqual([])
      }),
    )

    testEffect(testLayer(noHttp(githubHttp))).effect("strips v prefix from GitHub release tag", () =>
      Effect.gen(function* () {
        release = (url) =>
          url === `${RELEASE_API}/releases/latest` ? jsonResponse({ tag_name: "v4.0.0-beta.1" }) : undefined
        const result = yield* Installation.use.latest("curl")
        expect(result).toBe("4.0.0-beta.1")
        expect(fetched).toEqual([`${RELEASE_API}/releases/latest`])
        expect(githubHttp).toEqual([])
      }),
    )

    const npmCalls: string[] = []
    testEffect(
      testLayer((request) => {
        npmCalls.push(request.url)
        return jsonResponse({ version: "1.5.0" })
      }),
    ).effect("reads npm versions via registry", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("npm")
        expect(result).toBe("1.5.0")
        expect(npmCalls).toContain(`https://registry.npmjs.org/rafikicode/${InstallationChannel}`)
      }),
    )

    const bunCalls: string[] = []
    testEffect(
      testLayer((request) => {
        bunCalls.push(request.url)
        return jsonResponse({ version: "1.6.0" })
      }),
    ).effect("reads bun versions via registry", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("bun")
        expect(result).toBe("1.6.0")
        expect(bunCalls).toContain(`https://registry.npmjs.org/rafikicode/${InstallationChannel}`)
      }),
    )

    const pnpmCalls: string[] = []
    testEffect(
      testLayer((request) => {
        pnpmCalls.push(request.url)
        return jsonResponse({ version: "1.7.0" })
      }),
    ).effect("reads pnpm versions via registry", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("pnpm")
        expect(result).toBe("1.7.0")
        expect(pnpmCalls).toContain(`https://registry.npmjs.org/rafikicode/${InstallationChannel}`)
      }),
    )

    testEffect(testLayer(() => jsonResponse({ version: "2.3.4" }))).effect("reads scoop manifest versions", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("scoop")
        expect(result).toBe("2.3.4")
      }),
    )

    testEffect(testLayer(() => jsonResponse({ d: { results: [{ Version: "3.4.5" }] } }))).effect(
      "reads chocolatey feed versions",
      () =>
        Effect.gen(function* () {
          const result = yield* Installation.use.latest("choco")
          expect(result).toBe("3.4.5")
        }),
    )

    testEffect(
      testLayer(
        () => jsonResponse({ versions: { stable: "2.0.0" } }),
        (cmd, args) => {
          // getBrewFormula: return core formula (no tap)
          if (cmd === "brew" && args.includes("--formula") && args.includes("anomalyco/tap/opencode")) return ""
          if (cmd === "brew" && args.includes("--formula") && args.includes("opencode")) return "opencode"
          return ""
        },
      ),
    ).effect("reads brew formulae API versions", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("brew")
        expect(result).toBe("2.0.0")
      }),
    )

    const brewInfoJson = JSON.stringify({
      formulae: [{ versions: { stable: "2.1.0" } }],
    })
    testEffect(
      testLayer(
        () => jsonResponse({}), // HTTP not used for tap formula
        (cmd, args) => {
          if (cmd === "brew" && args.includes("anomalyco/tap/opencode") && args.includes("--formula")) return "opencode"
          if (cmd === "brew" && args.includes("--json=v2")) return brewInfoJson
          return ""
        },
      ),
    ).effect("reads brew tap info JSON via CLI", () =>
      Effect.gen(function* () {
        const result = yield* Installation.use.latest("brew")
        expect(result).toBe("2.1.0")
      }),
    )
  })

  describe("upgrade", () => {
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd) => {
          if (cmd === "npm") return { code: 1, stderr: "token=secret command output" }
          return ""
        },
      ),
    ).effect("returns sanitized typed errors for failed package upgrades", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("npm", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe("Upgrade failed for npm (exit code 1).")
        expect(error.message).toBe(error.stderr)
        expect(error.stderr).not.toContain("secret")
        expect(error.stderr).not.toContain("command output")
      }),
    )

    // The curl method downloads the release archive and checks it against
    // SHA256SUMS (src/rafiki/update.ts). Both tests fail before anything is
    // extracted, so the running binary is never replaced.
    const curlHttp: string[] = []
    testEffect(testLayer(noHttp(curlHttp))).effect("returns sanitized typed errors when the release download fails", () =>
      Effect.gen(function* () {
        const sums = `${RELEASE_DOWNLOAD}/v9.9.9/SHA256SUMS`
        release = (url) => (url === sums ? new Response("not found token=secret", { status: 404 }) : undefined)
        const error = yield* Effect.flip(Installation.use.upgrade("curl", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe(`Upgrade failed for curl. Could not download SHA256SUMS (404) from ${sums}`)
        expect(error.message).toBe(error.stderr)
        expect(error.stderr).not.toContain("secret")
        expect(fetched).toEqual([sums])
        expect(curlHttp).toEqual([])
      }),
    )

    const spawned: string[] = []
    testEffect(
      testLayer(noHttp(curlHttp), (cmd) => {
        spawned.push(cmd)
        return { code: 1, stderr: "should not run anything during curl upgrade" }
      }),
    ).effect("verifies the release checksum and never pipes an install script into a shell during curl upgrade", () =>
      Effect.gen(function* () {
        const variant = yield* Effect.promise(() => RafikiUpdate.detectVariant(process.platform, process.arch))
        const asset = RafikiUpdate.assetName(process.platform, process.arch, variant)
        const sums = `${RELEASE_DOWNLOAD}/v9.9.9/SHA256SUMS`
        release = (url) => {
          if (url === sums) return new Response(`${"0".repeat(64)}  ${asset}\n`)
          if (url === `${RELEASE_DOWNLOAD}/v9.9.9/${asset}`) return new Response("#!/bin/sh\necho token=secret\n")
          return undefined
        }
        const error = yield* Effect.flip(Installation.use.upgrade("curl", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toStartWith(`Upgrade failed for curl. Checksum mismatch for ${asset}: expected ${"0".repeat(64)}`)
        expect(error.stderr).toEndWith("Nothing was installed.")
        expect(error.stderr).not.toContain("secret")
        expect(fetched).toEqual([sums, `${RELEASE_DOWNLOAD}/v9.9.9/${asset}`])
        expect(curlHttp).toEqual([])
        expect(spawned).toEqual([])
        expect(yield* Effect.promise(() => fs.access(`${process.execPath}.new`).then(() => true, () => false))).toBe(false)
      }),
    )
  })
})
