// Finding the rafikicode binary. Pure: the file system and the environment
// are passed in, so the search order is unit tested without VS Code.
//
// Order: the rafikicode.path setting, then every PATH entry, then the
// installer's default directory (~/.rafikicode/bin, or RAFIKICODE_INSTALL_DIR
// when VS Code was started with it), then a few common install directories.
import * as path from "path"

export const BINARY_NAME = "rafikicode"
export const INSTALL_LINE = "curl -fsSL https://get.rafikiai.io | bash"
export const INSTALL_DIR_ENV = "RAFIKICODE_INSTALL_DIR"

export type BinarySource = "setting" | "path" | "installer" | "common"

export interface BinaryProbe {
  platform: NodeJS.Platform
  home: string
  env: Record<string, string | undefined>
  isExecutable(file: string): boolean
}

export interface BinaryFound {
  found: true
  path: string
  source: BinarySource
}

export interface BinaryMissing {
  found: false
  // Every file that was checked, in order.
  tried: string[]
  // Set when the rafikicode.path setting names something unusable.
  settingProblem?: string
}

export type BinaryResult = BinaryFound | BinaryMissing

function pathApi(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix
}

export function executableNames(platform: NodeJS.Platform) {
  return platform === "win32" ? [`${BINARY_NAME}.exe`, `${BINARY_NAME}.cmd`, BINARY_NAME] : [BINARY_NAME]
}

// Expands a leading ~ to the home directory.
export function expandHome(value: string, home: string, platform: NodeJS.Platform) {
  const p = pathApi(platform)
  if (value === "~") {
    return home
  }
  if (value.startsWith("~/") || (platform === "win32" && value.startsWith("~\\"))) {
    return p.join(home, value.slice(2))
  }
  return value
}

function pathEntries(env: BinaryProbe["env"], platform: NodeJS.Platform) {
  // Windows keeps the variable as Path; look it up without regard to case.
  const key = Object.keys(env).find((name) => (platform === "win32" ? name.toLowerCase() === "path" : name === "PATH"))
  const value = key ? env[key] : undefined
  if (!value) {
    return []
  }
  const separator = platform === "win32" ? ";" : ":"
  return value
    .split(separator)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
}

function installerDirs(probe: BinaryProbe) {
  const p = pathApi(probe.platform)
  const dirs: string[] = []
  const override = probe.env[INSTALL_DIR_ENV]
  if (override) {
    dirs.push(expandHome(override, probe.home, probe.platform))
  }
  dirs.push(p.join(probe.home, ".rafikicode", "bin"))
  return dirs
}

function commonDirs(probe: BinaryProbe) {
  const p = pathApi(probe.platform)
  if (probe.platform === "win32") {
    const dirs: string[] = []
    if (probe.env["APPDATA"]) {
      dirs.push(p.join(probe.env["APPDATA"], "npm"))
    }
    return dirs
  }
  const dirs = [p.join(probe.home, ".local", "bin"), "/usr/local/bin"]
  if (probe.platform === "darwin") {
    dirs.push("/opt/homebrew/bin")
  }
  return dirs
}

export function findBinary(setting: string | undefined, probe: BinaryProbe): BinaryResult {
  const p = pathApi(probe.platform)
  const tried: string[] = []
  const configured = setting?.trim()
  if (configured) {
    const file = expandHome(configured, probe.home, probe.platform)
    tried.push(file)
    if (!p.isAbsolute(file)) {
      return { found: false, tried, settingProblem: `rafikicode.path must be an absolute path, got "${configured}".` }
    }
    if (probe.isExecutable(file)) {
      return { found: true, path: file, source: "setting" }
    }
    return { found: false, tried, settingProblem: `rafikicode.path points to ${file}, which is not an executable file.` }
  }

  const names = executableNames(probe.platform)
  const groups: Array<[BinarySource, string[]]> = [
    ["path", pathEntries(probe.env, probe.platform)],
    ["installer", installerDirs(probe)],
    ["common", commonDirs(probe)],
  ]
  for (const [source, dirs] of groups) {
    for (const dir of dirs) {
      for (const name of names) {
        const file = p.join(dir, name)
        if (tried.includes(file)) {
          continue
        }
        tried.push(file)
        if (probe.isExecutable(file)) {
          return { found: true, path: file, source }
        }
      }
    }
  }
  return { found: false, tried }
}

export function missingMessage(result: BinaryMissing) {
  if (result.settingProblem) {
    return `${result.settingProblem} Fix the setting, or clear it to search PATH and ~/.rafikicode/bin.`
  }
  return `Rafiki Code could not find the rafikicode command. Install it with: ${INSTALL_LINE}`
}
