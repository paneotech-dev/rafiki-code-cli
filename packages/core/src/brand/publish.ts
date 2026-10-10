// Shell commands that publish code: a git push in any form, and the gh
// commands that create a repository, a pull request, a release or a gist, or
// change one on GitHub. The shell tool asks the person before running one of
// these every time, even when the shell is otherwise allowed, and
// `rafikicode run` refuses them unless pushes were allowed for that run
// (packages/opencode/src/tool/shell.ts, src/permission/index.ts, src/cli/cmd/run.ts).
//
// Pure, no I/O. The command text is split the way a POSIX shell or
// PowerShell would split it closely enough to find every simple command in
// it: lists (; && || & |), groups and subshells, command substitutions
// ($(...) and backticks), `sh -c` and `eval` strings. Words in front of the
// command that only change how it runs (VAR=value, env, sudo, command, exec,
// nohup, time, nice, timeout, xargs, stdbuf) are skipped, and so are git's
// global options (-C <dir>, -c <name>=<value>, --git-dir, ...). A git alias is
// expanded when the caller can look it up (`git config --get alias.<name>`),
// and an alias given inline with -c alias.<name>=<value> always is.
//
// This is a guard against a push nobody asked for, not a sandbox: a program
// or a script file that pushes by itself is not seen.

export const PERMISSION = "publish"

export interface Finding {
  // The simple command that publishes, as written.
  command: string
  // What it does, in a few words: "git push", "git push (force)", "gh pr create".
  what: string
}

export type AliasLookup = (name: string) => string | undefined

const MAX_DEPTH = 6

// Words that run the rest of the command line as a command of their own.
const PASSTHROUGH = new Set(["command", "builtin", "exec", "nohup", "time", "nice", "timeout", "stdbuf", "xargs", "sudo", "doas", "env", "chronic", "unbuffer", "caffeinate"])
// Options of those words that take a separate value.
const PASSTHROUGH_VALUE: Record<string, Set<string>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  sudo: new Set(["-u", "--user", "-g", "--group", "-C", "--close-from", "-D", "--chdir", "-h", "--host", "-p", "--prompt", "-r", "--role", "-t", "--type", "-U", "--other-user"]),
  doas: new Set(["-u", "-C"]),
  nice: new Set(["-n", "--adjustment"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  xargs: new Set(["-I", "-i", "-n", "--max-args", "-L", "-l", "--max-lines", "-P", "--max-procs", "-d", "--delimiter", "-s", "--max-chars", "-E", "-e", "--eof", "-a", "--arg-file"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  time: new Set(["-f", "--format", "-o", "--output"]),
}
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "pwsh", "powershell", "cmd"])
const GIT_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path", "--list-cmds", "--attr-source"])
// git subcommands that never publish; anything else may be an alias.
const GIT_BUILTIN = new Set([
  "add", "am", "apply", "archive", "bisect", "blame", "branch", "bundle", "cat-file", "check-ignore", "checkout", "cherry", "cherry-pick",
  "clean", "clone", "commit", "config", "describe", "diff", "difftool", "fetch", "format-patch", "fsck", "gc", "grep", "help", "init",
  "log", "ls-files", "ls-remote", "ls-tree", "merge", "merge-base", "mv", "notes", "pull", "rebase", "reflog", "remote", "reset",
  "restore", "rev-list", "rev-parse", "revert", "rm", "shortlog", "show", "show-ref", "sparse-checkout", "stash", "status",
  "submodule", "switch", "symbolic-ref", "tag", "update-index", "version", "worktree", "for-each-ref", "hash-object", "count-objects",
  "maintenance", "range-diff", "var", "whatchanged", "annotate", "mergetool", "prune", "repack", "verify-commit", "verify-tag",
])

function basename(word: string) {
  const name = word.split(/[\\/]/).pop() ?? word
  return name.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase()
}

// Splits a command line into simple commands (each a list of words), and
// collects the text of command substitutions to look into as well.
export function split(text: string): { commands: string[][]; nested: string[] } {
  const commands: string[][] = []
  const nested: string[] = []
  let words: string[] = []
  let word = ""
  let inWord = false
  const endWord = () => {
    if (inWord) words.push(word)
    word = ""
    inWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) commands.push(words)
    words = []
  }
  // The text up to the parenthesis that closes one opened just before i.
  const balanced = (start: number) => {
    let depth = 1
    let quote: string | undefined
    for (let j = start; j < text.length; j++) {
      const c = text[j]
      if (quote) {
        if (c === "\\" && quote === '"') j++
        else if (c === quote) quote = undefined
        continue
      }
      if (c === "'" || c === '"') quote = c
      else if (c === "\\") j++
      else if (c === "(") depth++
      else if (c === ")" && --depth === 0) return j
    }
    return text.length
  }
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === "\\" && i + 1 < text.length) {
      if (text[i + 1] === "\n") {
        i += 2
        continue
      }
      word += text[i + 1]
      inWord = true
      i += 2
      continue
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      const stop = end === -1 ? text.length : end
      word += text.slice(i + 1, stop)
      inWord = true
      i = stop + 1
      continue
    }
    if (c === '"') {
      inWord = true
      i++
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) {
          word += text[i + 1]
          i += 2
          continue
        }
        if (text[i] === "$" && text[i + 1] === "(") {
          const end = balanced(i + 2)
          nested.push(text.slice(i + 2, end))
          word += text.slice(i, end + 1)
          i = end + 1
          continue
        }
        if (text[i] === "`") {
          const end = text.indexOf("`", i + 1)
          const stop = end === -1 ? text.length : end
          nested.push(text.slice(i + 1, stop))
          i = stop + 1
          continue
        }
        word += text[i]
        i++
      }
      i++
      continue
    }
    if (c === "$" && text[i + 1] === "(") {
      const end = balanced(i + 2)
      nested.push(text.slice(i + 2, end))
      word += text.slice(i, end + 1)
      inWord = true
      i = end + 1
      continue
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1)
      const stop = end === -1 ? text.length : end
      nested.push(text.slice(i + 1, stop))
      inWord = true
      i = stop + 1
      continue
    }
    if (c === "#" && !inWord) {
      const end = text.indexOf("\n", i)
      i = end === -1 ? text.length : end
      continue
    }
    if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "\r" || c === "(" || c === ")" || c === "{" || c === "}") {
      // A brace inside a word (a git refspec like @{u}) is part of the word.
      if ((c === "{" || c === "}") && inWord) {
        word += c
        i++
        continue
      }
      endCommand()
      i++
      continue
    }
    if (c === " " || c === "\t") {
      endWord()
      i++
      continue
    }
    if ((c === ">" || c === "<") && !inWord) {
      // A redirection: skip the operator and its target word.
      i++
      while (text[i] === ">" || text[i] === "&") i++
      while (text[i] === " " || text[i] === "\t") i++
      while (i < text.length && !/[\s;&|()]/.test(text[i])) i++
      continue
    }
    word += c
    inWord = true
    i++
  }
  endCommand()
  return { commands, nested }
}

// Drops the words in front of a command that only change how it runs.
function strip(words: string[], depth: number, lookup: AliasLookup | undefined, findings: Finding[]): string[] {
  let rest = words
  for (let guard = 0; guard < 20 && rest.length; guard++) {
    const first = rest[0]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      rest = rest.slice(1)
      continue
    }
    const name = basename(first)
    if (name === "eval") {
      detectInto(rest.slice(1).join(" "), depth + 1, lookup, findings)
      return []
    }
    if (!PASSTHROUGH.has(name)) return rest
    const valued = PASSTHROUGH_VALUE[name] ?? new Set<string>()
    let j = 1
    while (j < rest.length) {
      const word = rest[j]
      if (name === "env" && (word === "-S" || word === "--split-string")) {
        detectInto(rest.slice(j + 1).join(" "), depth + 1, lookup, findings)
        return []
      }
      if (name === "env" && word.startsWith("--split-string=")) {
        detectInto([word.slice("--split-string=".length), ...rest.slice(j + 1)].join(" "), depth + 1, lookup, findings)
        return []
      }
      if (word === "--") {
        j++
        break
      }
      if (word.startsWith("-") && word !== "-") {
        j += valued.has(word) ? 2 : 1
        continue
      }
      if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
        j++
        continue
      }
      // timeout and nice take a bare number before the command.
      if ((name === "timeout" || name === "nice") && /^[+-]?\d+(\.\d+)?[smhd]?$/.test(word)) {
        j++
        continue
      }
      break
    }
    rest = rest.slice(j)
  }
  return rest
}

function git(words: string[], line: string, depth: number, lookup: AliasLookup | undefined, findings: Finding[]) {
  const inline = new Map<string, string>()
  let i = 1
  while (i < words.length) {
    const word = words[i]
    if (word === "-c" && words[i + 1]) {
      const m = words[i + 1].match(/^alias\.([^=]+)=(.*)$/i)
      if (m) inline.set(m[1].toLowerCase(), m[2])
    }
    if (GIT_VALUE.has(word)) {
      i += 2
      continue
    }
    if (word.startsWith("-")) {
      i++
      continue
    }
    break
  }
  const sub = words[i]
  if (!sub) return
  const args = words.slice(i + 1)
  if (sub === "push") {
    const force = args.some((a) => a === "-f" || a === "--force" || a.startsWith("--force-with-lease") || a === "--force-if-includes" || /^\+[^\s]/.test(a) || (/^-[a-z]+$/.test(a) && a.includes("f")))
    const remove = args.some((a) => a === "-d" || a === "--delete" || /^:[^\s]/.test(a))
    const mirror = args.includes("--mirror")
    const what = ["git push", force ? "force" : undefined, remove ? "deletes a remote branch" : undefined, mirror ? "mirror" : undefined].filter(Boolean)
    findings.push({ command: line, what: what.length > 1 ? `${what[0]} (${what.slice(1).join(", ")})` : "git push" })
    return
  }
  if (sub === "send-pack") return void findings.push({ command: line, what: "git send-pack" })
  if ((sub === "subtree" || sub === "lfs") && args.some((a) => a === "push")) return void findings.push({ command: line, what: `git ${sub} push` })
  if (GIT_BUILTIN.has(sub)) return
  const alias = inline.get(sub.toLowerCase()) ?? lookup?.(sub)
  if (!alias || depth >= MAX_DEPTH) return
  const expansion = alias.trim()
  const before = findings.length
  if (expansion.startsWith("!")) detectInto(`${expansion.slice(1)} ${args.join(" ")}`, depth + 1, lookup, findings)
  else detectInto(`git ${expansion} ${args.join(" ")}`, depth + 1, lookup, findings)
  for (let k = before; k < findings.length; k++) findings[k] = { command: line, what: `${findings[k].what}, through the git alias ${sub}` }
}

function gh(words: string[], line: string, findings: Finding[]) {
  const positional: string[] = []
  const flags: string[] = []
  for (let i = 1; i < words.length; i++) {
    const word = words[i]
    if (word.startsWith("-")) {
      flags.push(word)
      if ((word === "-R" || word === "--repo" || word === "--hostname") && i + 1 < words.length) i++
      else if ((word === "-X" || word === "--method") && i + 1 < words.length) flags.push(words[++i])
      continue
    }
    positional.push(word)
  }
  const [group, action] = positional
  const what = (label: string) => findings.push({ command: line, what: label })
  if (group === "pr" && (action === "create" || action === "new" || action === "merge")) return what(`gh pr ${action}`)
  if (group === "repo" && (action === "create" || action === "new" || action === "sync" || action === "rename")) return what(`gh repo ${action}`)
  if (group === "repo" && action === "edit" && flags.some((f) => f.startsWith("--visibility"))) return what("gh repo edit --visibility")
  if (group === "release" && action && !["list", "ls", "view", "download", "verify", "verify-asset"].includes(action)) return what(`gh release ${action}`)
  if (group === "gist" && (action === "create" || action === "new" || action === "edit")) return what(`gh gist ${action}`)
  if (group === "api") {
    const method = flags.find((_, k) => k > 0 && (flags[k - 1] === "-X" || flags[k - 1] === "--method"))
    const inlineMethod = flags.find((f) => /^(-X|--method=)/.test(f) && f.length > 2 && f !== "--method")
    const verb = (method ?? inlineMethod?.replace(/^(-X|--method=)/, ""))?.toUpperCase()
    const writes = flags.some((f) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(f) || /^-[fF].+/.test(f))
    if ((verb && verb !== "GET" && verb !== "HEAD") || (!verb && writes)) return what(`gh api ${verb ?? "POST"}`)
  }
}

function detectInto(text: string, depth: number, lookup: AliasLookup | undefined, findings: Finding[]) {
  if (depth > MAX_DEPTH || !text.trim()) return
  const { commands, nested } = split(text)
  for (const inner of nested) detectInto(inner, depth + 1, lookup, findings)
  for (const raw of commands) {
    const words = strip(raw, depth, lookup, findings)
    if (!words.length) continue
    const name = basename(words[0])
    const line = raw.join(" ")
    if (SHELLS.has(name)) {
      const at = words.findIndex((w, k) => k > 0 && (/^-[a-z]*c$/i.test(w) || /^[-/]c(ommand)?$/i.test(w)))
      if (at !== -1 && words[at + 1] !== undefined) detectInto(words.slice(at + 1).join(" "), depth + 1, lookup, findings)
      continue
    }
    if (name === "git" || name === "hub") git(words, line, depth, lookup, findings)
    else if (name === "gh") gh(words, line, findings)
  }
}

// Every simple command in `text` that publishes code. `lookup` resolves a git
// alias (its configured value) in the directory the command will run in.
export function detect(text: string, lookup?: AliasLookup): Finding[] {
  const findings: Finding[] = []
  detectInto(text, 0, lookup, findings)
  return findings
}

// Pushes allowed for this run without a question: `rafikicode run
// --allow-push`, RAFIKICODE_ALLOW_PUSH=1, or "publish": "allow" in the
// permission config. Only `rafikicode run` reads this; the terminal
// interface asks every time.
export function allowedByEnv(env: Record<string, string | undefined> = process.env) {
  return ["1", "true", "yes"].includes((env["RAFIKICODE_ALLOW_PUSH"] ?? "").toLowerCase())
}

export function allowedByConfig(permission: unknown) {
  if (!permission || typeof permission !== "object") return false
  const value = (permission as Record<string, unknown>)[PERMISSION]
  return value === "allow"
}

// The line `rafikicode run` prints when it refuses a push.
export function refusal(product: string) {
  return `${product} run does not publish code unless the run allows it: rerun with --allow-push, set RAFIKICODE_ALLOW_PUSH=1, or put "permission": { "publish": "allow" } in the config of this CI job.`
}
