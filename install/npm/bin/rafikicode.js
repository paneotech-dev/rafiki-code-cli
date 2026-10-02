#!/usr/bin/env node
// Launcher of the rafikicode npm package: starts the binary that install.js
// placed in ../vendor, with the same arguments, and exits with its status. When
// the binary is not there, because the package manager skipped install scripts,
// it is downloaded and verified first.
"use strict"

const childProcess = require("child_process")
const { install, installed, binaryPath } = require("../install.js")
const version = require("../package.json").version

function run(binary) {
  // The terminal signals the whole foreground group, so the binary gets its own
  // interrupt; this process only has to outlive it and pass on the exit status.
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {})
  const result = childProcess.spawnSync(binary, process.argv.slice(2), { stdio: "inherit", windowsHide: true })
  if (result.error) {
    process.stderr.write(`rafikicode: could not start ${binary}: ${result.error.message}\n`)
    process.exit(1)
  }
  if (result.signal) {
    process.removeAllListeners(result.signal)
    process.kill(process.pid, result.signal)
    return
  }
  process.exit(result.status === null ? 1 : result.status)
}

if (installed(version)) {
  run(binaryPath())
} else {
  install()
    .then(run)
    .catch((cause) => {
      process.stderr.write(`rafikicode: ${cause && cause.message ? cause.message : cause}\n`)
      process.exit(1)
    })
}
