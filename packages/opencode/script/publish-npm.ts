#!/usr/bin/env bun
// Publishes the rafikicode npm package for one release. Fork only.
//
// The package is the wrapper in install/npm: it holds no binary, and downloads
// the archive for the machine from the GitHub release of the same version,
// checked against the SHA-256 values packed into it here from that release's
// SHA256SUMS. So it must be published after the release it points at, and from
// the SHA256SUMS that release published, which is what ./dist holds in the
// release workflow.
//
//   OPENCODE_VERSION  the release version, required
//   DRY_RUN=1         pack with `npm pack --dry-run` instead of publishing
//   PACK=1            write the tarball into ./dist/npm and publish nothing
//                     (the release gate installs that tarball)
//
// Publishing needs NODE_AUTH_TOKEN. Without it this stops with a message
// naming the secret: a release that says it is on npm and is not is worse than
// a failed job.
import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"
import { Script } from "@opencode-ai/script"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const version = process.env["OPENCODE_VERSION"]
if (!version) {
  console.error("OPENCODE_VERSION is not set: the npm package must carry the version of the release it downloads")
  process.exit(1)
}
const sums = process.env["RAFIKICODE_SHA256SUMS"] ?? "./dist/SHA256SUMS"
if (!(await Bun.file(sums).exists())) {
  console.error(`no ${sums}: package the release archives first, the npm package is built from their checksums`)
  process.exit(1)
}

const out = path.resolve("./dist/npm")
await $`node ../../install/npm/build.mjs --version ${version} --sums ${sums} --out ${out}`
const pkg = path.join(out, "rafikicode")
const name = (await Bun.file(path.join(pkg, "package.json")).json()).name as string

if (process.env["PACK"] === "1") {
  await $`npm pack --pack-destination ${out}`.cwd(pkg)
  process.exit(0)
}
if (process.env["DRY_RUN"] === "1") {
  console.log(`dry run: ${name}@${version}`)
  await $`npm pack --dry-run`.cwd(pkg)
  process.exit(0)
}
if (!process.env["NODE_AUTH_TOKEN"]) {
  console.error(
    `NPM_TOKEN is not set, so ${name}@${version} cannot be published. Add the repository secret NPM_TOKEN (an npm automation token with publish rights on ${name}) and run the release workflow again for this tag.`,
  )
  process.exit(1)
}
if ((await $`npm view ${name}@${version} version`.quiet().nothrow()).exitCode === 0) {
  console.log(`already published ${name}@${version}`)
  process.exit(0)
}
await $`npm publish --access public --tag ${Script.channel}`.cwd(pkg)
