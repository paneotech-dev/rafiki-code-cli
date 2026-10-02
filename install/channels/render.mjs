#!/usr/bin/env node
// Renders the Homebrew formula and the winget manifests for one release.
//
//   node install/channels/render.mjs --version 0.2.0 --sums path/to/SHA256SUMS --out dir
//
// Output:
//   <out>/homebrew/rafikicode.rb
//   <out>/winget/PaneoTech.RafikiCode.yaml
//   <out>/winget/PaneoTech.RafikiCode.installer.yaml
//   <out>/winget/PaneoTech.RafikiCode.locale.en-US.yaml
//
// Every URL points at this repository's GitHub release for that version and
// every hash comes from the SHA256SUMS given, which is the file published with
// the release. A template that names an archive SHA256SUMS does not list fails
// the render: a channel must never be published with a hash that was not
// checked against the release.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
export const BASE = "https://github.com/paneotech-dev/rafiki-code-cli/releases"

export const TEMPLATES = [
  ["homebrew/rafikicode.rb.tmpl", "homebrew/rafikicode.rb"],
  ["winget/PaneoTech.RafikiCode.yaml.tmpl", "winget/PaneoTech.RafikiCode.yaml"],
  ["winget/PaneoTech.RafikiCode.installer.yaml.tmpl", "winget/PaneoTech.RafikiCode.installer.yaml"],
  ["winget/PaneoTech.RafikiCode.locale.en-US.yaml.tmpl", "winget/PaneoTech.RafikiCode.locale.en-US.yaml"],
]

// sha256sum format: "<hash>  <name>" or "<hash> *<name>".
export function parseSums(text) {
  const sums = new Map()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(\S+)$/.exec(line.trim())
    if (match) sums.set(path.basename(match[2]), match[1].toLowerCase())
  }
  return sums
}

export function render(template, version, sums) {
  const hash = (name) => {
    const value = sums.get(name)
    if (!value) throw new Error(`SHA256SUMS has no entry for ${name}`)
    return value
  }
  const text = template
    .replaceAll("{{VERSION}}", version)
    .replaceAll("{{BASE}}", BASE)
    .replace(/\{\{SHA256:([^}]+)\}\}/g, (_, name) => hash(name))
    .replace(/\{\{SHA256_UPPER:([^}]+)\}\}/g, (_, name) => hash(name).toUpperCase())
  const left = /\{\{[^}]*\}\}/.exec(text)
  if (left) throw new Error(`unknown placeholder ${left[0]}`)
  return text
}

function arg(name) {
  const at = process.argv.indexOf(`--${name}`)
  const value = at === -1 ? undefined : process.argv[at + 1]
  if (!value) {
    console.error("usage: render.mjs --version <version> --sums <SHA256SUMS> --out <dir>")
    process.exit(2)
  }
  return value
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = arg("version").replace(/^v/, "")
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    // Homebrew and winget carry stable releases only.
    console.error(`--version must be a release version such as 0.2.0, got ${version}`)
    process.exit(2)
  }
  const sums = parseSums(fs.readFileSync(arg("sums"), "utf8"))
  const out = path.resolve(arg("out"))
  try {
    for (const [from, to] of TEMPLATES) {
      const text = render(fs.readFileSync(path.join(here, from), "utf8"), version, sums)
      fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true })
      fs.writeFileSync(path.join(out, to), text)
      console.log(path.join(out, to))
    }
  } catch (cause) {
    console.error(`render failed: ${cause.message}`)
    process.exit(1)
  }
}
