// The actions auto mode still asks about, and what plan mode refuses. Pure,
// no I/O: the caller passes what it knows about the machine in a Context.
//
// Auto mode (permission/index.ts in the opencode package) runs tool calls
// without a question, except the guarded actions found here:
//
//   publish           publishing code (publish.ts, asked by its own question)
//   recursive-delete  rm -r, find -delete, git clean -d, Remove-Item -Recurse, rsync --delete
//   outside-delete    a delete outside the project folder and the temp folder
//   outside-write     a write outside the project folder and the temp folder
//   system            a write to a system path, or a command that changes the system
//   privilege         sudo, su, doas, pkexec, runas
//   history-rewrite   git push --force, reset --hard, filter-branch, branch -D of the default branch
//   network-shell     a download piped into a shell (curl ... | sh)
//   credentials       reading or writing ~/.ssh, ~/.aws, .env outside the project, the sign-in file
//   package-publish   npm publish and the like
//   kill              stopping a process the session did not start
//   email             the email tool
//
// Shell commands are read with the same parser as the publish detection
// (publish.ts split and unwrap): lists, pipes, subshells, command
// substitutions, `sh -c` and `eval` strings, env prefixes and wrappers such as
// sudo, env, timeout and xargs. A command the rules know nothing about (a
// program not in the lists below, inline interpreter code, a long script) is
// reported as unknown, for the risk check to look at.
//
// This is a guard against an unwanted action, not a sandbox: a program or a
// script file that does any of this by itself is not seen.
import path from "path"
import * as Publish from "./publish"

export type Kind =
  | "publish"
  | "recursive-delete"
  | "outside-delete"
  | "outside-write"
  | "system"
  | "privilege"
  | "history-rewrite"
  | "network-shell"
  | "credentials"
  | "package-publish"
  | "kill"
  | "email"

export interface Finding {
  kind: Kind
  // The simple command (or the path) it was found in, as written.
  command: string
  // The words that make it guarded (sudo, rm -r, git reset --hard). A rule
  // that allows a command counts as an explicit allow only when its fixed part
  // covers these words.
  key: string
  // One line for the person: "recursive delete: rm -rf build".
  reason: string
  // True for a push, which the publish question already asked about.
  publish?: boolean
}

export interface Context {
  // Where the command runs.
  cwd: string
  // The project folder and its repository root.
  roots: string[]
  // Temp folders: writes and deletes there are not guarded.
  temp: string[]
  home: string
  // Files holding the sign-in of this product.
  authFiles?: string[]
  // Branch names that count as the default branch.
  defaultBranches?: string[]
  // A git alias in the folder the command runs in.
  gitAlias?: Publish.AliasLookup
  // True when the session started the process with this id (or its group).
  owns?: (pid: number) => boolean
  platform?: NodeJS.Platform
}

export interface Result {
  findings: Finding[]
  // Simple commands the rules cannot classify.
  unknown: string[]
  // False only when every simple command is known to change nothing (plan mode).
  changes: boolean
}

const MAX_DEPTH = 6
// A command this long, or with this many lines, is a script: the rules do not
// claim to know what it does.
const LONG_SCRIPT = 1200
const LONG_LINES = 15

const label: Record<Kind, string> = {
  publish: "publishes code",
  "recursive-delete": "recursive delete",
  "outside-delete": "deletes outside the project folder",
  "outside-write": "writes outside the project folder",
  system: "changes the system",
  privilege: "runs with administrator rights",
  "history-rewrite": "rewrites git history",
  "network-shell": "runs a download as a script",
  credentials: "reads or writes credentials",
  "package-publish": "publishes a package",
  kill: "stops a process this session did not start",
  email: "sends email",
}

export function describe(kind: Kind) {
  return label[kind]
}

const PRIVILEGE = new Set(["sudo", "su", "doas", "pkexec", "runas", "gsudo", "sudoedit"])
const SHELL_SINKS = new Set([
  ...Publish.SHELLS,
  "python",
  "python3",
  "perl",
  "ruby",
  "node",
  "bun",
  "deno",
  "php",
  "iex",
  "invoke-expression",
  "source",
  ".",
])
const NETWORK = new Set(["curl", "wget", "fetch", "aria2c", "http", "https", "xh", "iwr", "irm", "invoke-webrequest", "invoke-restmethod", "lwp-request", "ftp"])
const DELETE = new Set(["rm", "unlink", "rmdir", "shred", "remove-item", "ri", "del", "erase", "rd", "trash", "srm"])
const COPY = new Set(["cp", "mv", "install", "ln", "rsync", "copy-item", "move-item", "copy", "move", "cpio", "scp"])
const TOUCH = new Set(["touch", "mkdir", "truncate", "chmod", "chown", "chgrp", "setfacl", "xattr", "chattr", "new-item", "set-content", "add-content", "out-file", "md", "mkfifo", "mknod"])
const SYSTEM_COMMANDS = new Set([
  "systemctl",
  "service",
  "launchctl",
  "update-rc.d",
  "chkconfig",
  "mount",
  "umount",
  "fdisk",
  "parted",
  "sfdisk",
  "mkswap",
  "swapon",
  "swapoff",
  "useradd",
  "userdel",
  "usermod",
  "groupadd",
  "groupdel",
  "passwd",
  "chpasswd",
  "visudo",
  "chsh",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "iptables",
  "ip6tables",
  "nft",
  "ufw",
  "firewall-cmd",
  "sysctl",
  "modprobe",
  "insmod",
  "rmmod",
  "grub-install",
  "update-grub",
  "bcdedit",
  "diskutil",
  "csrutil",
  "nvram",
  "reg",
  "set-itemproperty",
  "new-itemproperty",
  "remove-itemproperty",
  "set-executionpolicy",
  "dism",
  "sc",
  "netsh",
])
const SYSTEM_PACKAGES = new Set(["apt", "apt-get", "aptitude", "dpkg", "yum", "dnf", "rpm", "zypper", "pacman", "apk", "emerge", "snap", "flatpak", "port", "choco", "winget", "scoop"])
const PACKAGE_CHANGE = new Set(["install", "remove", "purge", "uninstall", "erase", "upgrade", "dist-upgrade", "full-upgrade", "autoremove", "reinstall", "-i", "-r", "-s", "-S", "-R", "-U", "-P", "add", "del", "refresh"])
const KILL = new Set(["kill", "pkill", "killall", "taskkill", "stop-process", "spps", "xkill", "skill", "slay"])
// git subcommands that only read.
const GIT_READ = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "annotate",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "rev-parse",
  "rev-list",
  "describe",
  "grep",
  "shortlog",
  "cat-file",
  "show-ref",
  "for-each-ref",
  "diff-tree",
  "diff-index",
  "diff-files",
  "merge-base",
  "name-rev",
  "count-objects",
  "check-ignore",
  "check-attr",
  "var",
  "version",
  "help",
  "whatchanged",
  "range-diff",
  "verify-commit",
  "verify-tag",
  "cherry",
  "fsck",
])
// Programs that change nothing by themselves (plan mode lets them run).
const READ_ONLY = new Set([
  "ls",
  "dir",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "tree",
  "pwd",
  "echo",
  "printf",
  "true",
  "false",
  "test",
  "[",
  "which",
  "whereis",
  "type",
  "file",
  "stat",
  "du",
  "df",
  "date",
  "whoami",
  "id",
  "uname",
  "hostname",
  "printenv",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "cut",
  "tr",
  "diff",
  "cmp",
  "comm",
  "jq",
  "column",
  "nl",
  "od",
  "xxd",
  "hexdump",
  "strings",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "sha512sum",
  "shasum",
  "cksum",
  "md5",
  "seq",
  "sleep",
  "ps",
  "uptime",
  "free",
  "lsof",
  "netstat",
  "ss",
  "ping",
  "nproc",
  "cd",
  "pushd",
  "popd",
  "export",
  "set",
  "unset",
  "alias",
  "history",
  "get-childitem",
  "gci",
  "get-content",
  "gc",
  "get-location",
  "select-string",
  "get-item",
  "test-path",
  "get-command",
  "write-output",
  "write-host",
  "set-location",
  "findstr",
  "where",
  "fd",
  "fzf",
  "bat",
  "eza",
  "exa",
  "zcat",
  "locale",
  "env",
  "sort",
  "uniq",
  "sed",
  "awk",
  "find",
  "git",
  "curl",
  "wget",
  "npm",
  "pnpm",
  "yarn",
  "node",
  "python",
  "python3",
  "go",
  "cargo",
  "tsc",
])
// Programs the rules know: ordinary development work. A program outside this
// list is unknown, and goes to the risk check in auto mode.
const KNOWN = new Set([
  ...READ_ONLY,
  ...DELETE,
  ...COPY,
  ...TOUCH,
  ...PRIVILEGE,
  ...SYSTEM_COMMANDS,
  ...SYSTEM_PACKAGES,
  ...KILL,
  ...NETWORK,
  ...Publish.SHELLS,
  "tee",
  "dd",
  "tar",
  "zip",
  "unzip",
  "gzip",
  "gunzip",
  "xz",
  "bzip2",
  "7z",
  "patch",
  "make",
  "cmake",
  "ninja",
  "meson",
  "bazel",
  "gradle",
  "gradlew",
  "mvn",
  "mvnw",
  "ant",
  "sbt",
  "npx",
  "bunx",
  "pnpx",
  "bun",
  "deno",
  "corepack",
  "nvm",
  "volta",
  "pip",
  "pip3",
  "pipx",
  "uv",
  "uvx",
  "poetry",
  "pipenv",
  "conda",
  "mamba",
  "pytest",
  "tox",
  "nox",
  "ruff",
  "black",
  "isort",
  "flake8",
  "mypy",
  "pyright",
  "pylint",
  "coverage",
  "rustc",
  "rustup",
  "rustfmt",
  "clippy-driver",
  "gofmt",
  "golangci-lint",
  "java",
  "javac",
  "kotlin",
  "kotlinc",
  "dotnet",
  "gcc",
  "g++",
  "cc",
  "c++",
  "clang",
  "clang++",
  "ld",
  "ar",
  "ruby",
  "gem",
  "bundle",
  "bundler",
  "rake",
  "rails",
  "rspec",
  "php",
  "composer",
  "phpunit",
  "artisan",
  "perl",
  "swift",
  "swiftc",
  "xcodebuild",
  "xcrun",
  "flutter",
  "dart",
  "elixir",
  "mix",
  "erl",
  "rebar3",
  "ghc",
  "cabal",
  "stack",
  "zig",
  "lua",
  "luarocks",
  "r",
  "rscript",
  "julia",
  "eslint",
  "prettier",
  "biome",
  "oxlint",
  "jest",
  "vitest",
  "mocha",
  "ava",
  "playwright",
  "cypress",
  "vite",
  "webpack",
  "rollup",
  "esbuild",
  "turbo",
  "nx",
  "lerna",
  "next",
  "nuxt",
  "astro",
  "svelte-kit",
  "tsx",
  "ts-node",
  "docker",
  "docker-compose",
  "podman",
  "kubectl",
  "helm",
  "terraform",
  "gh",
  "hub",
  "brew",
  "xargs",
  "nohup",
  "time",
  "timeout",
  "watch",
  "entr",
  "code",
  "open",
  "xdg-open",
  "ssh",
  "rsync",
  "nc",
  "dig",
  "nslookup",
  "host",
  "traceroute",
  "openssl",
  "base64",
  "sqlite3",
  "psql",
  "mysql",
  "redis-cli",
  "mongosh",
  "magick",
  "convert",
  "ffmpeg",
  "pandoc",
  "jupyter",
  "ipython",
  "source",
  ".",
  "exit",
  "return",
  "wait",
  "jobs",
  "read",
  "local",
  "declare",
  "shift",
  "trap",
  "ulimit",
  "umask",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "in",
  "function",
  "break",
  "continue",
  "yes",
  "clear",
  "tput",
  "stty",
  "rafikicode",
])
// Interpreter flags that take the program as an argument: the code is not read.
const INLINE_CODE: Record<string, Set<string>> = {
  python: new Set(["-c"]),
  python3: new Set(["-c"]),
  node: new Set(["-e", "--eval", "-p", "--print"]),
  bun: new Set(["-e", "--eval", "-p", "--print"]),
  deno: new Set(["eval"]),
  perl: new Set(["-e", "-E"]),
  ruby: new Set(["-e"]),
  php: new Set(["-r"]),
  lua: new Set(["-e"]),
  rscript: new Set(["-e"]),
  osascript: new Set(["-e"]),
}
// Package registries: the command and the words that publish to one.
const PACKAGE_PUBLISH: Array<[string, (args: string[]) => string | undefined]> = [
  ["npm", (a) => first(a, ["publish", "unpublish", "deprecate", "dist-tag"])],
  ["pnpm", (a) => first(a, ["publish"])],
  ["yarn", (a) => (a.includes("publish") ? "publish" : undefined)],
  ["bun", (a) => first(a, ["publish"])],
  ["deno", (a) => first(a, ["publish"])],
  ["jsr", (a) => first(a, ["publish"])],
  ["lerna", (a) => first(a, ["publish"])],
  ["changeset", (a) => first(a, ["publish"])],
  ["cargo", (a) => first(a, ["publish", "yank", "owner"])],
  ["gem", (a) => first(a, ["push", "yank", "owner"])],
  ["twine", (a) => first(a, ["upload"])],
  ["poetry", (a) => first(a, ["publish"])],
  ["uv", (a) => first(a, ["publish"])],
  ["flit", (a) => first(a, ["publish"])],
  ["hatch", (a) => first(a, ["publish"])],
  ["pdm", (a) => first(a, ["publish"])],
  ["dotnet", (a) => (a[0] === "nuget" && a[1] === "push" ? "nuget push" : undefined)],
  ["nuget", (a) => first(a, ["push", "delete"])],
  ["mvn", (a) => (a.includes("deploy") || a.some((w) => w.endsWith(":deploy")) ? "deploy" : undefined)],
  ["mvnw", (a) => (a.includes("deploy") ? "deploy" : undefined)],
  ["gradle", (a) => a.find((w) => /^publish/i.test(w))],
  ["gradlew", (a) => a.find((w) => /^publish/i.test(w))],
  ["docker", (a) => (a[0] === "push" || (a[0] === "image" && a[1] === "push") || (a[0] === "buildx" && a.includes("--push")) ? "push" : undefined)],
  ["podman", (a) => first(a, ["push"])],
  ["helm", (a) => first(a, ["push"])],
  ["vsce", (a) => first(a, ["publish", "unpublish"])],
  ["ovsx", (a) => first(a, ["publish"])],
  ["pod", (a) => (a[0] === "trunk" && a[1] === "push" ? "trunk push" : undefined)],
  ["mix", (a) => first(a, ["hex.publish"])],
  ["dart", (a) => (a[0] === "pub" && a[1] === "publish" ? "pub publish" : undefined)],
  ["flutter", (a) => (a[0] === "pub" && a[1] === "publish" ? "pub publish" : undefined)],
  ["swift", (a) => (a[0] === "package-registry" && a[1] === "publish" ? "package-registry publish" : undefined)],
  ["goreleaser", (a) => (a.includes("--snapshot") ? undefined : "release")],
]

function first(args: string[], words: string[]) {
  const positional = args.filter((a) => !a.startsWith("-"))
  return positional[0] !== undefined && words.includes(positional[0]) ? positional[0] : undefined
}

function name(word: string | undefined) {
  if (word === undefined) return ""
  const base = Publish.basename(word)
  // ./gradlew and gradlew.bat both count as gradlew.
  return base.replace(/\.(sh|bat|ps1)$/i, "")
}

// ---------------------------------------------------------------------------
// Paths

function slash(p: string) {
  return p.replaceAll("\\", "/")
}

function inside(child: string, parent: string) {
  const rel = path.relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

// A word as a path on this machine, or undefined when it cannot be known
// (a variable other than HOME, a command substitution).
export function resolve(word: string, cwd: string | undefined, home: string): string | undefined {
  let text = word.trim()
  if (!text) return undefined
  if (/^(https?|ssh|git|ftp|s3|gs):\/\//i.test(text)) return undefined
  text = text.replace(/^~(?=$|[\\/])/, home)
  text = text.replace(/^\$\{?HOME\}?(?=$|[\\/])/, home)
  text = text.replace(/^%USERPROFILE%(?=$|[\\/])/i, home)
  text = text.replace(/^\$env:USERPROFILE(?=$|[\\/])/i, home)
  if (/\$|`|%[A-Za-z_]+%/.test(text)) return undefined
  // Windows drive paths are kept as written.
  if (/^[A-Za-z]:[\\/]/.test(text)) return slash(path.win32.normalize(text))
  if (path.isAbsolute(text)) return path.normalize(text)
  if (cwd === undefined) return undefined
  return path.resolve(cwd, text)
}

const SYSTEM_PREFIXES = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/boot",
  "/sys",
  "/proc",
  "/opt",
  "/var",
  "/srv",
  "/System",
  "/Library",
  "/Applications",
  "/private/etc",
  "/private/var",
  "/dev",
]
const SYSTEM_EXCEPT = ["/var/tmp", "/var/folders", "/private/var/folders", "/private/tmp", "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/fd", "/dev/zero", "/dev/random", "/dev/urandom"]
const WINDOWS_SYSTEM = [/^[a-z]:\/windows(\/|$)/i, /^[a-z]:\/program files( \(x86\))?(\/|$)/i, /^[a-z]:\/programdata(\/|$)/i]

export function systemPath(file: string) {
  const p = slash(file)
  if (WINDOWS_SYSTEM.some((re) => re.test(p))) return true
  if (SYSTEM_EXCEPT.some((prefix) => p === prefix || p.startsWith(prefix + "/"))) return false
  return SYSTEM_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + "/"))
}

// Files and folders that hold credentials, under the home folder.
const HOME_SECRETS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".azure",
  ".config/gcloud",
  ".kube/config",
  ".docker/config.json",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".config/gh/hosts.yml",
  ".terraform.d/credentials.tfrc.json",
  ".config/rclone/rclone.conf",
  ".password-store",
  ".local/share/keyrings",
]

export function credentialPath(file: string, ctx: Pick<Context, "home" | "roots" | "authFiles">) {
  const p = slash(file)
  const home = slash(ctx.home)
  if (HOME_SECRETS.some((item) => p === `${home}/${item}` || p.startsWith(`${home}/${item}/`))) return true
  if ((ctx.authFiles ?? []).some((item) => slash(item) === p)) return true
  if (/\/(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$/.test(p) && !p.endsWith(".pub")) return true
  if (p === "/etc/shadow" || p === "/etc/sudoers" || p.startsWith("/etc/sudoers.d/")) return true
  const base = path.posix.basename(p)
  // A .env file of another project; the project's own .env is its business.
  if (/^\.env(\..+)?$/.test(base) && !/\.(example|sample|template|dist)$/.test(base)) {
    return !ctx.roots.some((root) => inside(file, root))
  }
  return false
}

function allowedPlace(file: string, ctx: Context) {
  return [...ctx.roots.filter((root) => root !== "/"), ...ctx.temp].some((dir) => inside(file, dir))
}

// What a write to (or a delete of) this file is, when it is guarded.
const DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero"])

function placeKind(file: string, ctx: Context, op: "write" | "delete"): Kind | undefined {
  if (DEVICES.has(slash(file)) || slash(file).startsWith("/dev/fd/") || /(^|[\\/])nul$/i.test(file)) return undefined
  if (credentialPath(file, ctx)) return "credentials"
  if (allowedPlace(file, ctx)) return undefined
  if (systemPath(file)) return "system"
  return op === "delete" ? "outside-delete" : "outside-write"
}

// ---------------------------------------------------------------------------
// Files touched by a tool (edit, write, read)

// The guarded finding for a tool that writes `file`, or undefined.
export function fileWrite(file: string, ctx: Context): Finding | undefined {
  const kind = placeKind(file, ctx, "write")
  if (!kind) return undefined
  return { kind, command: file, key: file, reason: `${label[kind]}: ${file}` }
}

// The guarded finding for a tool that reads `file`, or undefined: reading is
// guarded only for credentials.
export function fileRead(file: string, ctx: Context): Finding | undefined {
  if (!credentialPath(file, ctx)) return undefined
  return { kind: "credentials", command: file, key: file, reason: `${label.credentials}: ${file}` }
}

// ---------------------------------------------------------------------------
// Shell commands

type Walk = {
  findings: Finding[]
  unknown: string[]
  changes: boolean
  cwd: string | undefined
}

function add(walk: Walk, kind: Kind, command: string, key: string, extra?: Partial<Finding>) {
  if (walk.findings.some((item) => item.kind === kind && item.command === command)) return
  walk.findings.push({ kind, command, key, reason: `${label[kind]}: ${command}`, ...extra })
}

// The words of a simple command that name files: every word that is not an
// option, and the value of --option=value.
function paths(args: string[]) {
  return args.flatMap((word) => {
    if (word === "-" || word === "--") return []
    const eq = word.match(/^--?[A-Za-z][\w-]*=(.+)$/)
    if (eq) return [eq[1]]
    if (/^of=|^if=/.test(word)) return [word.slice(3)]
    if (word.startsWith("-")) return []
    return [word]
  })
}

function recursive(prog: string, args: string[]) {
  if (prog === "rm" || prog === "trash" || prog === "srm") return args.some((a) => a === "--recursive" || /^-[a-zA-Z]*[rR]/.test(a))
  if (prog === "remove-item" || prog === "ri" || prog === "del" || prog === "erase" || prog === "rd" || prog === "rmdir") {
    return args.some((a) => /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(a) || /^\/s$/i.test(a))
  }
  if (prog === "shred") return args.some((a) => a === "-r" || a === "--recursive")
  return false
}

function looksLikeOutput(word: string) {
  // A redirection written inside a word (2>/dev/null, x>file): its target.
  const m = word.match(/^[^>]*?(?:\d|&)?>>?\|?([^>&].*)$/)
  return m ? m[1] : undefined
}

function checkTargets(walk: Walk, ctx: Context, command: string, targets: string[], op: "write" | "delete") {
  for (const target of targets) {
    const file = resolve(target, walk.cwd, ctx.home)
    if (!file) continue
    const kind = placeKind(file, ctx, op)
    if (kind) add(walk, kind, command, command)
  }
}

function checkCredentials(walk: Walk, ctx: Context, command: string, words: string[]) {
  for (const word of paths(words)) {
    const file = resolve(word, walk.cwd, ctx.home)
    if (file && credentialPath(file, ctx)) add(walk, "credentials", command, command)
  }
}

function gitRules(walk: Walk, ctx: Context, words: string[], command: string, depth: number) {
  const parsed = Publish.gitCommand(words)
  const sub = parsed.sub
  if (!sub) return
  const args = parsed.args
  const flags = args.filter((a) => a.startsWith("-"))
  const positional = args.filter((a) => !a.startsWith("-"))
  if (sub === "push") {
    const force = args.some(
      (a) => a === "-f" || a === "--force" || a.startsWith("--force-with-lease") || a === "--force-if-includes" || /^\+[^\s]/.test(a) || (/^-[a-z]+$/.test(a) && a.includes("f")),
    )
    if (force) add(walk, "history-rewrite", command, "git push --force", { publish: true })
    walk.changes = true
    return
  }
  if (sub === "reset" && flags.includes("--hard")) {
    add(walk, "history-rewrite", command, "git reset --hard")
  }
  if (sub === "filter-branch" || sub === "filter-repo") add(walk, "history-rewrite", command, `git ${sub}`)
  if (sub === "branch") {
    const force = flags.includes("-D") || ((flags.includes("-d") || flags.includes("--delete")) && (flags.includes("-f") || flags.includes("--force")))
    const branches = new Set(ctx.defaultBranches ?? ["main", "master"])
    if (force && positional.some((b) => branches.has(b))) add(walk, "history-rewrite", command, "git branch -D")
    const reads = args.length === 0 || args.every((a) => /^(-a|-r|-v|-vv|--all|--remotes|--list|-l|--show-current|--contains|--merged|--no-merged|--format.*|--sort.*|--color.*|--no-color|--verbose)$/.test(a))
    if (!reads) walk.changes = true
    return
  }
  if (sub === "clean") {
    const deletes = flags.some((f) => f === "-d" || f === "-x" || f === "-X" || (/^-[a-zA-Z]+$/.test(f) && /[dxX]/.test(f)))
    if (deletes) add(walk, "recursive-delete", command, "git clean")
    walk.changes = true
    return
  }
  if (GIT_READ.has(sub)) {
    if (sub === "diff" && flags.some((f) => f.startsWith("--output"))) walk.changes = true
    return
  }
  if (sub === "tag" && (args.length === 0 || args.every((a) => /^(-l|--list|-n\d*|--sort.*|--contains|--points-at|--merged|--no-merged|--format.*|--column|--no-column)$/.test(a) || !a.startsWith("-")) && (args.length === 0 || args.includes("-l") || args.includes("--list")))) return
  if (sub === "remote" && (args.length === 0 || ["-v", "--verbose", "show", "get-url"].includes(args[0]))) return
  if (sub === "config" && args.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a))) return
  if (sub === "stash" && ["list", "show"].includes(args[0] ?? "")) return
  if (sub === "worktree" && args[0] === "list") return
  if (sub === "reflog" && (args.length === 0 || args[0] === "show")) return
  if (sub === "symbolic-ref" && positional.length <= 1 && !flags.some((f) => f === "-d" || f === "--delete")) return
  walk.changes = true
  if (Publish.GIT_BUILTIN.has(sub) || ["send-pack", "subtree", "lfs", "update-ref", "gc", "notes", "init", "clone"].includes(sub)) return
  // An alias: classified by what it expands to.
  const alias = parsed.inline.get(sub.toLowerCase()) ?? ctx.gitAlias?.(sub)
  if (!alias || depth >= MAX_DEPTH) return
  const expansion = alias.trim()
  const text = expansion.startsWith("!") ? `${expansion.slice(1)} ${args.join(" ")}` : `git ${expansion} ${args.join(" ")}`
  const before = walk.findings.length
  visit(text, ctx, walk, depth + 1)
  for (let k = before; k < walk.findings.length; k++) {
    walk.findings[k] = { ...walk.findings[k], command, reason: `${walk.findings[k].reason}, through the git alias ${sub}` }
  }
}

function killRules(walk: Walk, ctx: Context, prog: string, args: string[], command: string) {
  if (prog !== "kill") return add(walk, "kill", command, prog)
  if (args.some((a) => a === "-l" || a === "-L" || a === "--list" || a === "-0")) return
  const ids: string[] = []
  // kill -9 -5000: once the signal is given, a negative number is a process group.
  let signal = false
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === "--") {
      ids.push(...args.slice(k + 1))
      break
    }
    if (a === "-s" || a === "-n" || a === "--signal") {
      signal = true
      k++
      continue
    }
    if (signal && /^-\d+$/.test(a)) {
      ids.push(a)
      continue
    }
    if (a.startsWith("-")) {
      signal = true
      continue
    }
    ids.push(a)
  }
  const own = (id: string) => id.startsWith("%") || id === "$!" || id === "${!}" || (/^-?\d+$/.test(id) && Boolean(ctx.owns?.(Math.abs(Number(id)))))
  if (!ids.length || !ids.every(own)) add(walk, "kill", command, "kill")
}

const KEYWORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!"])
const DOWNLOAD_IN_WORD = /\$\(\s*(curl|wget|fetch|iwr|irm|invoke-webrequest|invoke-restmethod)\b|`\s*(curl|wget)\b/i

function runsInput(words: string[]) {
  const sink = name(words[0]).toLowerCase()
  if (!SHELL_SINKS.has(sink)) return false
  if (Publish.SHELLS.has(sink) || ["iex", "invoke-expression", "source", "."].includes(sink)) return true
  // python3 script.py reads its own file; python3 - or a bare python3 runs the input.
  const rest = words.slice(1).filter((a) => !a.startsWith("-") || a === "-")
  return rest.length === 0 || rest[0] === "-"
}

function simple(raw: string[], redirects: Publish.Redirect[], ctx: Context, walk: Walk, depth: number): void {
  // if rm -rf x; then ...: the command after a keyword is a command too.
  if (raw.length && KEYWORDS.has(raw[0])) return simple(raw.slice(1), redirects, ctx, walk, depth)
  if (raw.length && ["for", "case", "function", "select"].includes(raw[0])) return
  const command = raw.join(" ")
  const unwrapped = Publish.unwrap(raw)
  for (const wrapper of unwrapped.wrappers) {
    const w = name(wrapper[0])
    if (PRIVILEGE.has(w)) add(walk, "privilege", command, w)
  }
  // Redirections: writes and reads of the files they name.
  for (const item of redirects) {
    if (/^\d+$/.test(item.target) || item.target.startsWith("&") || item.op.includes("<<")) continue
    const file = resolve(item.target, walk.cwd, ctx.home)
    const shown = `${command} ${item.op} ${item.target}`.trim()
    if (item.op.includes(">")) {
      if (file && !["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"].includes(file)) walk.changes = true
      if (file) checkTargets(walk, ctx, shown, [item.target], "write")
      else walk.unknown.push(shown)
    } else if (file && credentialPath(file, ctx)) add(walk, "credentials", shown, shown)
  }
  if (unwrapped.inner !== undefined) {
    // eval "$(curl ...)" and env -S "...".
    if (DOWNLOAD_IN_WORD.test(unwrapped.inner)) add(walk, "network-shell", command, command)
    visit(unwrapped.inner, ctx, walk, depth + 1)
    return
  }
  const words = unwrapped.rest
  if (!words.length) return
  const prog = name(words[0])
  const lower = prog.toLowerCase()
  const args = words.slice(1)

  // Words written as redirections inside a word: x>file, 2>/dev/null.
  const inWord = args.map(looksLikeOutput).filter((t): t is string => t !== undefined)
  for (const target of inWord) {
    if (/^\d+$/.test(target) || target === "/dev/null") continue
    walk.changes = true
    checkTargets(walk, ctx, command, [target], "write")
  }

  if (lower === "cd" || lower === "pushd" || lower === "set-location" || lower === "chdir") {
    const target = args.find((a) => !a.startsWith("-"))
    walk.cwd = target === undefined ? ctx.home : target === "-" ? undefined : resolve(target, walk.cwd, ctx.home)
    return
  }

  checkCredentials(walk, ctx, command, args)

  if (PRIVILEGE.has(lower)) {
    add(walk, "privilege", command, prog)
    walk.changes = true
    // su -c "...": look at the command it runs as well.
    const at = args.findIndex((a) => a === "-c" || a === "--command")
    if (at !== -1 && args[at + 1]) visit(args.slice(at + 1).join(" "), ctx, walk, depth + 1)
    else if (lower !== "su") {
      const from = args.findIndex((a) => !a.startsWith("-") && !a.startsWith("/"))
      if (from !== -1) simple(args.slice(from), [], ctx, walk, depth + 1)
    }
    return
  }

  // A download handed to a shell or an interpreter as text: bash -c "$(curl ...)".
  if (SHELL_SINKS.has(lower) && args.some((a) => DOWNLOAD_IN_WORD.test(a))) add(walk, "network-shell", command, prog)

  // A shell started with a script: the script is read as well.
  const script = Publish.shellScript(words)
  if (script !== undefined) {
    if (DOWNLOAD_IN_WORD.test(script)) add(walk, "network-shell", command, command)
    visit(script, ctx, walk, depth + 1)
    return
  }

  if (DELETE.has(lower)) {
    walk.changes = true
    if (recursive(lower, args)) add(walk, "recursive-delete", command, `${prog} ${args.find((a) => a.startsWith("-") || a.startsWith("/")) ?? ""}`.trim())
    const targets = paths(args)
    if (targets.some((t) => !resolve(t, walk.cwd, ctx.home))) walk.unknown.push(command)
    checkTargets(walk, ctx, command, targets, "delete")
    return
  }

  if (COPY.has(lower)) {
    walk.changes = true
    if (lower === "rsync" && args.some((a) => a.startsWith("--delete"))) add(walk, "recursive-delete", command, "rsync --delete")
    const files = paths(args).filter((a) => !/^[^/\s]+@?[^/\s]*:/.test(a) || /^[A-Za-z]:[\\/]/.test(a))
    const t = args.findIndex((a) => a === "-t" || a === "--target-directory")
    const dest = t !== -1 ? args[t + 1] : files.at(-1)
    if (dest !== undefined) {
      if (!resolve(dest, walk.cwd, ctx.home)) walk.unknown.push(command)
      checkTargets(walk, ctx, command, [dest], "write")
    }
    // mv takes the source away as well.
    if (lower === "mv" || lower === "move-item" || lower === "move") checkTargets(walk, ctx, command, files.slice(0, -1), "delete")
    return
  }

  if (TOUCH.has(lower) || lower === "tee") {
    walk.changes = true
    const files = paths(args).filter((a) => !(lower === "chmod" && /^[ugoa]*[+=-]|^\d+$/.test(a)) && !((lower === "chown" || lower === "chgrp") && a === paths(args)[0]))
    if (files.some((f) => !resolve(f, walk.cwd, ctx.home))) walk.unknown.push(command)
    checkTargets(walk, ctx, command, files, "write")
    return
  }

  if (lower === "dd") {
    walk.changes = true
    const of = args.find((a) => a.startsWith("of="))
    if (of) checkTargets(walk, ctx, command, [of.slice(3)], "write")
    return
  }

  if (lower === "sed" || lower === "perl") {
    if (args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))) {
      walk.changes = true
      const files = paths(args).slice(lower === "sed" && !args.some((a) => a === "-e" || a === "-f") ? 1 : 0)
      checkTargets(walk, ctx, command, files, "write")
    }
    if (lower === "perl" && args.some((a) => /^-[a-zA-Z]*[eE]$/.test(a))) walk.unknown.push(command)
    return
  }

  if (lower === "awk" || lower === "gawk" || lower === "mawk") {
    if (args.some((a) => /system\s*\(|print[^;]*>|\|\s*"/.test(a))) {
      walk.changes = true
      walk.unknown.push(command)
    }
    return
  }

  if (lower === "find" || lower === "fd") {
    if (args.some((a) => a === "-delete")) {
      walk.changes = true
      add(walk, "recursive-delete", command, "find -delete")
    }
    // find -exec rm -rf {} ;  The command it runs is read as well.
    const at = args.findIndex((a) => /^-(exec|execdir|ok|okdir|x|X)$|^--exec(-batch)?$/.test(a))
    if (at !== -1) {
      const end = args.findIndex((a, k) => k > at && (a === ";" || a === "+" || a === "\\;"))
      simple(args.slice(at + 1, end === -1 ? undefined : end), [], ctx, walk, depth + 1)
    }
    if (args.some((a) => /^-f(print|print0|printf|ls)$/.test(a))) walk.changes = true
    return
  }

  if (lower === "git" || lower === "hub") {
    gitRules(walk, ctx, words, command, depth)
    return
  }

  if (KILL.has(lower) || (lower === "fuser" && args.some((a) => /^-[a-zA-Z]*k/.test(a)))) {
    walk.changes = true
    killRules(walk, ctx, lower, args, command)
    return
  }

  if (SYSTEM_COMMANDS.has(lower)) {
    const reads = (lower === "systemctl" && ["status", "list-units", "list-unit-files", "is-active", "is-enabled", "show", "cat"].includes(args[0] ?? "")) || (lower === "sysctl" && !args.some((a) => a === "-w" || a.includes("="))) || (lower === "mount" && args.length === 0) || (lower === "reg" && /^query$/i.test(args[0] ?? "")) || (lower === "launchctl" && ["list", "print"].includes(args[0] ?? "")) || (lower === "iptables" && args.some((a) => a === "-L" || a === "--list" || a === "-S"))
    if (!reads) {
      walk.changes = true
      add(walk, "system", command, prog)
    }
    return
  }

  if (SYSTEM_PACKAGES.has(lower)) {
    const change = args.find((a) => PACKAGE_CHANGE.has(a))
    if (change && !(lower === "winget" || lower === "scoop")) {
      walk.changes = true
      add(walk, "system", command, `${prog} ${change}`)
    } else if (change) walk.changes = true
    return
  }

  if (lower === "crontab" && args.some((a) => a === "-r" || a === "-e" || (!a.startsWith("-") && a !== "-l"))) {
    walk.changes = true
    add(walk, "system", command, "crontab")
    return
  }

  for (const [tool, publish] of PACKAGE_PUBLISH) {
    if (lower !== tool) continue
    const what = publish(args)
    if (what) {
      walk.changes = true
      add(walk, "package-publish", command, `${prog} ${what}`)
      return
    }
  }
  // python -m twine upload, python -m poetry publish.
  if ((lower === "python" || lower === "python3" || lower === "py") && args[0] === "-m" && ["twine", "poetry", "flit", "hatch"].includes(args[1] ?? "") && args.some((a) => a === "upload" || a === "publish")) {
    walk.changes = true
    add(walk, "package-publish", command, `${prog} -m ${args[1]}`)
    return
  }
  // npx some-tool publish, bunx np, pnpm dlx ...: a package runner publishing.
  if ((lower === "npx" || lower === "bunx" || lower === "pnpx") && args.some((a) => a === "publish" || a === "np")) {
    walk.changes = true
    add(walk, "package-publish", command, `${prog} publish`)
    return
  }

  // Global installs write outside the project.
  if (["npm", "pnpm", "yarn", "bun"].includes(lower) && args.some((a) => a === "-g" || a === "--global" || a === "global")) {
    walk.changes = true
    add(walk, "outside-write", command, `${prog} -g`)
    return
  }

  // Downloads that write a file.
  if (lower === "curl") {
    const out = args.findIndex((a) => a === "-o" || a === "--output")
    if (out !== -1 && args[out + 1]) {
      walk.changes = true
      checkTargets(walk, ctx, command, [args[out + 1]], "write")
    }
    if (args.some((a) => a === "-O" || a === "--remote-name" || a === "-T" || a === "--upload-file" || /^(-d|--data.*|-F|--form|-X|--request)$/.test(a) || /^-[a-zA-Z]*O/.test(a))) walk.changes = true
    return
  }
  if (lower === "wget") {
    const out = args.findIndex((a) => a === "-O" || a === "--output-document")
    const toStdout = out !== -1 && args[out + 1] === "-"
    if (!toStdout && !args.some((a) => a === "-O-" || a === "--output-document=-" || a === "--spider")) walk.changes = true
    if (out !== -1 && args[out + 1] && args[out + 1] !== "-") checkTargets(walk, ctx, command, [args[out + 1]], "write")
    return
  }

  // Inline code given to an interpreter: the rules cannot read it.
  const inline = INLINE_CODE[prog]
  if (inline && args.some((a) => inline.has(a))) {
    walk.changes = true
    walk.unknown.push(command)
    return
  }

  if (READ_ONLY.has(lower) || READ_ONLY.has(prog)) {
    const tool = lower
    const reads =
      !["sort", "uniq", "sed", "awk", "find", "git", "curl", "wget", "npm", "pnpm", "yarn", "node", "python", "python3", "go", "cargo", "tsc", "env"].includes(tool) ||
      (tool === "sort" && !args.some((a) => a === "-o" || a.startsWith("--output"))) ||
      (tool === "uniq" && args.filter((a) => !a.startsWith("-")).length <= 1) ||
      (tool === "env" && args.length === 0) ||
      (["npm", "pnpm", "yarn"].includes(tool) && ["ls", "list", "view", "info", "outdated", "why", "explain", "search", "-v", "--version", "help", "config"].includes(args[0] ?? "") && !(args[0] === "config" && args[1] === "set")) ||
      (["node", "python", "python3", "go", "cargo", "tsc"].includes(tool) && args.length > 0 && args.every((a) => /^(-v|-V|--version|version|help|--help|-h)$/.test(a))) ||
      (tool === "go" && ["list", "env", "doc", "version", "vet"].includes(args[0] ?? "")) ||
      (tool === "cargo" && ["metadata", "tree", "search", "--version", "-V"].includes(args[0] ?? "")) ||
      (tool === "tsc" && args.includes("--noEmit"))
    if (!reads) walk.changes = true
    return
  }

  walk.changes = true
  if (!KNOWN.has(lower)) walk.unknown.push(command)
}

function visit(text: string, ctx: Context, walk: Walk, depth: number) {
  if (depth > MAX_DEPTH || !text.trim()) return
  const parsed = Publish.split(text)
  for (const inner of parsed.nested) {
    // A download run through $(...) or a process substitution.
    visit(inner, ctx, walk, depth + 1)
  }
  // The download a pipe is carrying, if any: curl ... | tee x | sh still runs it.
  let downloading: string | undefined
  parsed.commands.forEach((raw, i) => {
    simple(raw, parsed.redirects[i] ?? [], ctx, walk, depth)
    const words = Publish.unwrap(raw).rest
    const prog = name(words[0]).toLowerCase()
    const previous = i > 0 ? parsed.links[i - 1] : ""
    const piped = previous === "|" || previous === "|&"
    if (!piped) downloading = undefined
    if (piped && downloading && runsInput(words)) add(walk, "network-shell", `${downloading} | ${raw.join(" ")}`, downloading.split(" ")[0])
    if (NETWORK.has(prog)) downloading = raw.join(" ")
    // sh <(curl ...), source <(wget -O- ...)
    const following = parsed.commands[i + 1]
    if (parsed.links[i] === "(" && following && SHELL_SINKS.has(prog) && NETWORK.has(name(Publish.unwrap(following).rest[0]).toLowerCase())) {
      add(walk, "network-shell", `${raw.join(" ")} <(${following.join(" ")})`, prog)
    }
  })
  // iex (iwr https://...) in PowerShell, and a download given to an interpreter's inline code.
  if (/\b(iex|invoke-expression)\b[\s(]*\(?\s*(iwr|irm|invoke-webrequest|invoke-restmethod|\(new-object\s+net\.webclient\))/i.test(text)) add(walk, "network-shell", text.trim(), "iex")
}

// Every guarded action in a shell command, the parts the rules cannot
// classify, and whether it may change anything.
export function shell(command: string, ctx: Context): Result {
  const walk: Walk = { findings: [], unknown: [], changes: false, cwd: ctx.cwd }
  visit(command, ctx, walk, 0)
  for (const found of Publish.detect(command, ctx.gitAlias)) {
    if (!walk.findings.some((item) => item.command === found.command && item.kind === "publish")) {
      walk.findings.push({ kind: "publish", command: found.command, key: found.what, reason: `${label.publish}: ${found.what}`, publish: true })
    }
    walk.changes = true
  }
  const long = command.length > LONG_SCRIPT || command.split("\n").length > LONG_LINES
  const unknown = Array.from(new Set(long ? [command, ...walk.unknown] : walk.unknown))
  return { findings: walk.findings, unknown, changes: walk.changes || unknown.length > 0 }
}

// The fixed part of a rule pattern: the text before its first wildcard.
export function fixedPart(pattern: string) {
  const at = pattern.search(/[*?]/)
  return (at === -1 ? pattern : pattern.slice(0, at)).trim()
}

// True when an allow rule written for this command counts as an explicit
// allow of the finding: its fixed part covers the words that make the command
// guarded. "git reset --hard*" covers git reset --hard; "git *" does not.
export function covers(pattern: string, finding: Finding) {
  if (pattern === "*") return false
  const fixed = fixedPart(pattern)
  if (!fixed) return false
  const key = finding.key.trim()
  return fixed.length >= key.length || fixed.startsWith(key)
}

// The note plan mode returns instead of running an action.
export function planNote(what: string) {
  return `Plan mode is on, so nothing is changed: ${what} was not run. Do not retry it. Describe the change you propose instead (files, edits and commands); the person switches to Ask or Auto mode to apply it.`
}
