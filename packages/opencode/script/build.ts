#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

import { Script } from "@opencode-ai/script"
import pkg from "../package.json"
import {
  coverageRows,
  duplicateWarning,
  renderReport,
  skipReason,
  type BuiltBinary,
  type HostSpec,
} from "./platform-coverage.ts"
import { signMacOSBinary } from "./macos-signature.ts"

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`OPENCODE_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()
const treeSitterWorker = await Bun.file(fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"))).text()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // Skip abi-specific builds: they need extra Bun artifacts and cannot run
      // here anyway. Checked before the baseline flag, which used to return
      // early and so pulled the musl baseline target into --single --baseline.
      if (item.abi !== undefined) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      return true
    })
  : allTargets

await $`rm -rf dist`

const binaries: Record<string, string> = {}
const built: BuiltBinary[] = []
const executed = new Set<string>()

// Streamed rather than read whole: these binaries are ~185MB each and there are
// twelve of them.
const sha256Of = async (file: string) => {
  const hasher = new Bun.CryptoHasher("sha256")
  const reader = Bun.file(file).stream().getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    hasher.update(value)
  }
  return hasher.digest("hex")
}

// What this machine can run decides what the release can claim. AVX2 is part of
// it: a baseline target that starts on a host that has AVX2 says nothing about
// the CPUs the baseline variant exists for.
const hostAvx2 = await (async () => {
  if (process.platform === "linux") {
    const info = await Bun.file("/proc/cpuinfo")
      .text()
      .catch(() => "")
    return info ? /(?:^|\s)avx2(?:\s|$)/im.test(info) : undefined
  }
  if (process.platform === "darwin") {
    const probe = await $`sysctl -n hw.optional.avx2_0`.nothrow().quiet()
    const value = probe.stdout.toString().trim()
    return value ? value === "1" : undefined
  }
  return undefined
})()

const hostAbi = await (async () => {
  if (process.platform !== "linux") return undefined
  if (await Bun.file("/etc/alpine-release").exists()) return "musl" as const
  const probe = await $`ldd --version`.nothrow().quiet()
  const output = probe.stdout.toString() + probe.stderr.toString()
  return /musl/i.test(output) ? ("musl" as const) : undefined
})()

const host: HostSpec = {
  os: process.platform,
  arch: process.arch,
  ...(hostAbi ? { abi: hostAbi } : {}),
  ...(hostAvx2 === undefined ? {} : { avx2: hostAvx2 }),
}

if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
  await $`bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}`
}
for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  const workerPath = "./src/cli/tui/worker.ts"
  const treeSitterWorkerPath = "opentui-tree-sitter-worker.js"
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"

  await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/${pkg.name}`,
      execArgv: [`--user-agent=${pkg.name}/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: {
      [treeSitterWorkerPath]: treeSitterWorker,
      ...(embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {}),
    },
    entrypoints: [
      "./src/main.ts",
      workerPath,
      treeSitterWorkerPath,
      ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : []),
    ],
    define: {
      FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_MODELS_DEV: generated.modelsData,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + treeSitterWorkerPath,
      OPENCODE_WORKER_PATH: workerPath,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  // Embedding the bundle invalidates the linker's ad-hoc signature, and macOS
  // kills binaries with invalid pages. Re-sign ad hoc now that the file is final
  // (codesign on a Mac, rcodesign elsewhere) and check every page hash.
  if (item.os === "darwin") {
    await signMacOSBinary(`dist/${name}/bin/${pkg.name}`, {
      identifier: pkg.name,
      required: process.env["RAFIKICODE_REQUIRE_MACOS_SIGNATURE"] === "1",
    })
  }

  // Smoke test every target this host can execute, musl and baseline included.
  // The previous gate was `os === platform && arch === process.arch && !abi`,
  // which on the Linux release runner left exactly the two glibc x64 targets --
  // and those two turned out to be the same bytes, so one binary stood in for
  // all twelve. Record the hash either way, so a duplicate cannot pass silently.
  const plainPath = `dist/${name}/bin/${pkg.name}`
  const binaryPath = (await Bun.file(plainPath).exists()) ? plainPath : `${plainPath}.exe`
  const skip = skipReason(item, host)
  if (skip) {
    console.log(`Not executed: ${name} (${skip})`)
  } else {
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
      executed.add(name)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }
  built.push({ name, target: item, sha256: await sha256Of(binaryPath) })

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
        ...(item.abi ? { libc: [item.abi] } : {}),
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

// Write the release's own record of what was and was not exercised, beside the
// archives, so "has this ever been run on a Mac" does not depend on reading a
// workflow log that expires.
const report = renderReport(coverageRows(built, host, executed), host, Script.version)
await Bun.file("dist/PLATFORM-COVERAGE.md").write(report)
console.log("")
console.log(report)

const warning = duplicateWarning(built)
if (warning) {
  const rule = "=".repeat(72)
  console.log(rule)
  console.log(warning)
  console.log(rule)
  // Not fatal by default: the collision comes from the toolchain serving one
  // runtime per os/arch/abi, and failing every release outright would only move
  // the surprise. Set this in CI once the toolchain is fixed to keep it fixed.
  if (process.env["RAFIKICODE_REQUIRE_DISTINCT_TARGETS"] === "1") {
    console.error("Refusing to publish identical targets (RAFIKICODE_REQUIRE_DISTINCT_TARGETS=1).")
    process.exit(1)
  }
}

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
    }
  }
  await $`gh release upload v${Script.version} ./dist/*.zip ./dist/*.tar.gz --clobber --repo ${process.env.GH_REPO}`
}

export { binaries }
