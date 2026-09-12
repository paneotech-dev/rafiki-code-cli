#!/usr/bin/env bun
// Publishes the rafikicode npm packages from a finished build in ./dist:
// one platform package per binary (rafikicode-<os>-<arch>[-variant]) and the
// meta package "rafikicode" whose postinstall copies the right binary into
// place. Fork only; the upstream publish script also handles registries,
// AUR, Homebrew and desktop builds that this fork does not ship.
//
// DRY_RUN=1 packs every package with `npm pack --dry-run` instead of publishing.
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const dryRun = process.env["DRY_RUN"] === "1"

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.quiet().nothrow()).exitCode === 0
}

async function publish(path: string, name: string, version: string) {
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(path)
  if (dryRun) {
    console.log(`dry run: ${name}@${version}`)
    await $`npm pack --dry-run`.cwd(path)
    return
  }
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  await $`npm publish --access public --tag ${Script.channel}`.cwd(path)
}

const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob(`${pkg.name}-*/package.json`).scanSync({ cwd: "./dist" })) {
  const meta = await Bun.file(`./dist/${filepath}`).json()
  binaries[meta.name] = meta.version
}
if (Object.keys(binaries).length === 0) {
  console.error("no platform packages found in ./dist, run script/build.ts first")
  process.exit(1)
}
console.log("platform packages", binaries)
const version = Object.values(binaries)[0]

const meta = `./dist/${pkg.name}`
await $`rm -rf ${meta}`
await $`mkdir -p ${meta}/bin`
await $`cp ./script/postinstall.mjs ${meta}/postinstall.mjs`
await Bun.file(`${meta}/LICENSE`).write(await Bun.file("../../LICENSE").text())
await Bun.file(`${meta}/NOTICE`).write(await Bun.file("../../NOTICE").text())
await Bun.file(`${meta}/README.md`).write(
  [
    `# ${pkg.name}`,
    "",
    "The Rafiki Code terminal coding agent. Installing this package downloads the",
    "binary for your platform through an optional dependency and links it as",
    `\`${pkg.name}\`.`,
    "",
    "Other install channels and the documentation: https://code.rafikiai.io",
    "",
  ].join("\n"),
)
// Placeholder replaced by postinstall.mjs with the real binary. It only runs
// when a package manager skipped install scripts.
await Bun.file(`${meta}/bin/${pkg.name}.exe`).write(
  [
    `echo "Error: the ${pkg.name} postinstall script was not run." >&2`,
    'echo "" >&2',
    'echo "This happens with --ignore-scripts, or with package managers that skip" >&2',
    'echo "postinstall scripts by default. Run it manually:" >&2',
    `echo "  cd node_modules/${pkg.name} && node postinstall.mjs" >&2`,
    "exit 1",
    "",
  ].join("\n"),
)
await Bun.file(`${meta}/package.json`).write(
  JSON.stringify(
    {
      name: pkg.name,
      version,
      description: "Rafiki Code terminal coding agent",
      homepage: "https://code.rafikiai.io",
      license: pkg.license,
      bin: { [pkg.name]: `./bin/${pkg.name}.exe` },
      scripts: { postinstall: "node ./postinstall.mjs" },
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

for (const [name, ver] of Object.entries(binaries)) {
  await publish(`./dist/${name}`, name, ver)
}
await publish(meta, pkg.name, version)
