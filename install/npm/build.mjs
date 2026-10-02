#!/usr/bin/env node
// Assembles the rafikicode npm package for one release.
//
//   node install/npm/build.mjs --version 0.2.0 --sums path/to/SHA256SUMS --out dir
//
// Writes <out>/rafikicode/: the files of this directory, package.json with the
// release version, checksums.json built from the release's SHA256SUMS, and the
// repository's LICENSE and NOTICE. The package downloads its binary from the
// GitHub release of that version, so it must be published after the release.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, "../..")

function arg(name) {
  const at = process.argv.indexOf(`--${name}`)
  const value = at === -1 ? undefined : process.argv[at + 1]
  if (!value) {
    console.error(`usage: build.mjs --version <version> --sums <SHA256SUMS> --out <dir>`)
    process.exit(2)
  }
  return value
}

const version = arg("version").replace(/^v/, "")
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`--version must be a semantic version, got ${version}`)
  process.exit(2)
}
const sums = fs.readFileSync(arg("sums"), "utf8")
const out = path.join(path.resolve(arg("out")), "rafikicode")

// sha256sum format: "<hash>  <name>" or "<hash> *<name>".
const checksums = {}
for (const line of sums.split(/\r?\n/)) {
  const match = /^([a-fA-F0-9]{64})\s+\*?(rafikicode-[a-z0-9-]+\.(?:tar\.gz|zip))$/.exec(line.trim())
  if (match) checksums[match[2]] = match[1].toLowerCase()
}
if (Object.keys(checksums).length === 0) {
  console.error("SHA256SUMS names no rafikicode archive; refusing to build a package that cannot verify anything")
  process.exit(1)
}

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(path.join(out, "bin"), { recursive: true })
for (const file of ["install.js", "README.md", "bin/rafikicode.js"]) {
  fs.copyFileSync(path.join(here, file), path.join(out, file))
}
fs.chmodSync(path.join(out, "bin/rafikicode.js"), 0o755)
for (const file of ["LICENSE", "NOTICE"]) fs.copyFileSync(path.join(repo, file), path.join(out, file))
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"))
pkg.version = version
fs.writeFileSync(path.join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n")
fs.writeFileSync(path.join(out, "checksums.json"), JSON.stringify(checksums, null, 2) + "\n")
console.log(out)
