import { afterAll, beforeAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import { Brand } from "@opencode-ai/core/brand/brand"
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
const RELEASE_PAGE = "https://github.com/paneotech-dev/rafiki-code-cli/releases"
const RELEASE_DOWNLOAD = `${RELEASE_PAGE}/download`
// The release page answers /latest with a redirect to the newest tag. The
// updater reads that first and asks the rate limited API only when it gets no
// version from it.
function pageRedirect(version: string) {
  return new Response(null, { status: 302, headers: { location: `${RELEASE_PAGE}/tag/v${version}` } })
}
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
    testEffect(testLayer(noHttp(githubHttp))).effect("reads the release version from the release page redirect", () =>
      Effect.gen(function* () {
        release = (url) => (url === `${RELEASE_PAGE}/latest` ? pageRedirect("1.2.3") : undefined)
        const result = yield* Installation.use.latest("unknown")
        expect(result).toBe("1.2.3")
        // The API is not asked at all when the page answers.
        expect(fetched).toEqual([`${RELEASE_PAGE}/latest`])
        expect(githubHttp).toEqual([])
      }),
    )

    testEffect(testLayer(noHttp(githubHttp))).effect("falls back to the release API when the page gives no version", () =>
      Effect.gen(function* () {
        release = (url) => {
          if (url === `${RELEASE_PAGE}/latest`) return new Response("", { status: 200 })
          return url === `${RELEASE_API}/releases/latest` ? jsonResponse({ tag_name: "v4.0.0-beta.1" }) : undefined
        }
        const result = yield* Installation.use.latest("curl")
        expect(result).toBe("4.0.0-beta.1")
        expect(fetched).toEqual([`${RELEASE_PAGE}/latest`, `${RELEASE_API}/releases/latest`])
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

    /*
     * Whatever the install method outside npm, the newest version is read from
     * this product's own release page: no request to a Homebrew, Chocolatey or
     * Scoop feed, and no brew, choco, scoop or winget process.
     */
    for (const method of ["brew", "winget", "choco", "scoop"] as const) {
      const http: string[] = []
      const spawned: string[] = []
      testEffect(
        testLayer(noHttp(http), (cmd) => {
          spawned.push(cmd)
          return ""
        }),
      ).effect(`reads this product's own release for ${method} and touches no package manager`, () =>
        Effect.gen(function* () {
          release = (url) => (url === `${RELEASE_PAGE}/latest` ? pageRedirect("1.2.3") : undefined)
          const result = yield* Installation.use.latest(method)
          expect(result).toBe("1.2.3")
          expect(fetched).toEqual([`${RELEASE_PAGE}/latest`])
          expect(http).toEqual([])
          expect(spawned).toEqual([])
        }),
      )
    }
  })

  describe("upgrade", () => {
    /*
     * The refusal. choco and scoop are not channels of this product, and a
     * package of its name there belongs to the upstream project, so upgrading
     * through them would act on different software. It stops before running
     * anything, and the message names where the product is published.
     */
    for (const method of ["choco", "scoop"] as const) {
      const spawned: string[] = []
      testEffect(
        testLayer(
          () => jsonResponse({}),
          (cmd) => {
            spawned.push(cmd)
            return ""
          },
        ),
      ).effect(`refuses to upgrade through ${method} and runs nothing`, () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Installation.use.upgrade(method, "9.9.9"))
          expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
          expect(error.stderr).toBe(Brand.unpublishedHint(method))
          expect(error.stderr).toContain(Brand.release.installer)
          expect(spawned).toEqual([])
        }),
      )
    }

    /*
     * brew and winget are channels of this product, and each command names this
     * product's own package: the formula of its tap by full name, and its
     * winget identifier with --exact. A bare product name would match a
     * package of the same name published by someone else.
     */
    const brewCommands: string[][] = []
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          brewCommands.push([cmd, ...args])
          return ""
        },
      ),
    ).effect("upgrades through brew by the full name of this product's formula", () =>
      Effect.gen(function* () {
        yield* Installation.use.upgrade("brew", "9.9.9")
        const brew = brewCommands.filter((cmd) => cmd[0] === "brew")
        expect(brew).toEqual([
          ["brew", "tap", "paneotech-dev/tap"],
          ["brew", "update"],
          ["brew", "upgrade", "paneotech-dev/tap/rafikicode"],
        ])
      }),
    )

    const wingetCommands: string[][] = []
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          wingetCommands.push([cmd, ...args])
          return ""
        },
      ),
    ).effect("upgrades through winget by this product's exact identifier", () =>
      Effect.gen(function* () {
        yield* Installation.use.upgrade("winget", "9.9.9")
        const winget = wingetCommands.filter((cmd) => cmd[0] === "winget")
        expect(winget).toHaveLength(1)
        expect(winget[0].slice(0, 7)).toEqual(["winget", "upgrade", "--id", "PaneoTech.RafikiCode", "--exact", "--version", "9.9.9"])
      }),
    )

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

    // The curl method downloads the release archive, checks it against
    // SHA256SUMS and replaces process.execPath (src/rafiki/update.ts). This
    // test process is a run from source, where process.execPath is the runtime
    // itself, so the upgrade must stop as a typed error before it requests or
    // runs anything. The download and checksum rules are tested against a named
    // target file in test/brand/update.test.ts.
    const curlHttp: string[] = []
    const spawned: string[] = []
    testEffect(
      testLayer(noHttp(curlHttp), (cmd) => {
        spawned.push(cmd)
        return { code: 1, stderr: "should not run anything during curl upgrade" }
      }),
    ).effect("a curl upgrade from a source run is refused before any request, and nothing is piped into a shell", () =>
      Effect.gen(function* () {
        const before = yield* Effect.promise(() => fs.stat(process.execPath))
        release = () => new Response("should not be requested", { status: 500 })
        const error = yield* Effect.flip(Installation.use.upgrade("curl", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toStartWith("Upgrade failed for curl. This is a run from source")
        expect(error.stderr).toEndWith("Nothing was installed.")
        expect(error.message).toBe(error.stderr)
        expect(fetched).toEqual([])
        expect(curlHttp).toEqual([])
        expect(spawned).toEqual([])
        const after = yield* Effect.promise(() => fs.stat(process.execPath))
        expect(after.size).toBe(before.size)
        expect(yield* Effect.promise(() => fs.access(`${process.execPath}.new`).then(() => true, () => false))).toBe(false)
      }),
    )
  })
})
