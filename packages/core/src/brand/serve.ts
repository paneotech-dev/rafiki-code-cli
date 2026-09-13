// The local HTTP server of rafikicode serve, web, acp and the terminal
// interface's --port or --hostname option. It answers with the merged
// configuration, which carries the stored Rafiki key, and runs tools, so a
// server that other machines can reach must have a password
// (OPENCODE_SERVER_PASSWORD, sent as basic auth).
//
// check() refuses any address other than this machine without a password,
// and warns when a loopback server has none (any local program, and a web
// page through DNS rebinding, can still reach it).
import { Brand } from "./brand"

export const passwordEnv = "OPENCODE_SERVER_PASSWORD"
// The contract's usage exit code: the command line asked for something refused.
export const EXIT_REFUSED = 2

// True for addresses that only this machine can reach: 127.0.0.0/8, ::1,
// localhost. Everything else, including 0.0.0.0, :: and an empty host, is not.
export function loopback(hostname: string) {
  const host = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1")
  if (host === "localhost" || host === "::1") return true
  const parts = host.split(".")
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

export function check(input: { hostname: string; password?: string }): { refuse?: string; warn?: string } {
  if (input.password) return {}
  if (!loopback(input.hostname)) {
    return {
      refuse: `Refusing to listen on ${input.hostname || "every address"} without a password: the ${Brand.name} server answers with your configuration, including the ${Brand.product} key, and runs tools. Set ${passwordEnv}, or listen on 127.0.0.1.`,
    }
  }
  return {
    warn: `Warning: ${passwordEnv} is not set, so the server on ${input.hostname} has no password. Any program on this machine can use it and read the ${Brand.product} key.`,
  }
}

// Prints the refusal or the warning to stderr. True when the command must
// stop (exit code EXIT_REFUSED is set).
export function refused(input: { hostname: string }, write: (line: string) => void = (line) => process.stderr.write(line + "\n")) {
  const result = check({ hostname: input.hostname, password: process.env[passwordEnv] })
  if (result.refuse) {
    write(result.refuse)
    process.exitCode = EXIT_REFUSED
    return true
  }
  if (result.warn) write(result.warn)
  return false
}
