import { describe, expect, test } from "bun:test"
import * as Publish from "../../src/brand/publish"

const what = (text: string, lookup?: Publish.AliasLookup) => Publish.detect(text, lookup).map((f) => f.what)

describe("commands that publish code", () => {
  test.each([
    ["git push", "git push"],
    ["git push origin main", "git push"],
    ["git push -u origin feature/x", "git push"],
    ["git push --force", "git push (force)"],
    ["git push -f origin main", "git push (force)"],
    ["git push --force-with-lease origin main", "git push (force)"],
    ["git push origin +main", "git push (force)"],
    ["git push origin --delete old", "git push (deletes a remote branch)"],
    ["git push --mirror", "git push (mirror)"],
    ["git push --tags", "git push"],
    ["/usr/bin/git push", "git push"],
    ["git.exe push", "git push"],
    ["hub push", "git push"],
    ["git -C ../other push", "git push"],
    ["git -c core.sshCommand='ssh -i key' push", "git push"],
    ["git --git-dir=.git --work-tree . push", "git push"],
    ["git --no-pager push", "git push"],
    ["git subtree push --prefix dist origin gh-pages", "git subtree push"],
    ["git send-pack origin main", "git send-pack"],
    ["gh pr create --fill", "gh pr create"],
    ["gh pr merge 12 --squash", "gh pr merge"],
    ["gh repo create my-app --private --source . --push", "gh repo create"],
    ["gh -R me/x repo create y", "gh repo create"],
    ["gh release create v1.0.0 dist/*", "gh release create"],
    ["gh release upload v1 file.zip", "gh release upload"],
    ["gh gist create notes.md", "gh gist create"],
    ["gh repo edit --visibility public", "gh repo edit --visibility"],
    ["gh api -X PUT repos/me/x/contents/a.txt -f message=m", "gh api PUT"],
    ["gh api repos/me/x/git/refs -f ref=refs/heads/x", "gh api POST"],
  ])("%s", (text, expected) => {
    expect(what(text)).toEqual([expected])
  })

  test.each([
    ["compound with &&", "npm test && git push"],
    ["after a semicolon", "git add . ; git commit -m 'x' ; git push"],
    ["after ||", "false || git push"],
    ["in a pipe", "yes | git push"],
    ["in the background", "git push &"],
    ["on a second line", "git commit -m x\ngit push"],
    ["in a subshell", "(cd sub && git push)"],
    ["in a group", "{ git push; }"],
    ["in a command substitution", "echo $(git push)"],
    ["in backticks", "echo `git push`"],
    ["in a substitution inside double quotes", 'echo "result: $(git push 2>&1)"'],
    ["env prefix", "env GIT_SSH_COMMAND='ssh -i k' git push"],
    ["env with options", "env -i -u HOME PATH=/usr/bin git push"],
    ["env -S", "env -S 'git push origin main'"],
    ["assignment prefix", "GIT_TRACE=1 git push"],
    ["sudo", "sudo -u deploy git push"],
    ["command and exec", "command git push"],
    ["nohup and timeout", "nohup timeout 30 git push"],
    ["xargs", "echo origin | xargs -I{} git push {} main"],
    ["bash -c", "bash -c 'git push origin main'"],
    ["sh -lc", 'sh -lc "cd x && git push"'],
    ["pwsh -Command", "pwsh -NoProfile -Command \"git push\""],
    ["eval", "eval git push"],
    ["redirection before", "git push > out.log 2>&1"],
    ["quoted program name", "'git' push"],
  ])("found %s", (_, text) => {
    expect(what(text).length).toBeGreaterThan(0)
    expect(what(text)[0]).toStartWith("git push")
  })

  test("git aliases: inline and configured, including shell aliases", () => {
    expect(what("git -c alias.p=push p origin main")).toEqual(["git push, through the git alias p"])
    const aliases: Record<string, string> = { pu: "push -u origin HEAD", ship: "!git add -A && git commit -m wip && git push", st: "status" }
    const lookup = (name: string) => aliases[name]
    expect(what("git pu", lookup)).toEqual(["git push, through the git alias pu"])
    expect(what("git ship", lookup)).toEqual(["git push, through the git alias ship"])
    expect(what("git st", lookup)).toEqual([])
    // A builtin is never looked up.
    let asked = 0
    Publish.detect("git status && git log", () => {
      asked++
      return "push"
    })
    expect(asked).toBe(0)
  })

  test("an alias that refers to itself does not loop", () => {
    expect(what("git loop", () => "loop")).toEqual([])
  })

  test.each([
    "git status",
    "git log --oneline -5",
    "git commit -m 'git push later'",
    'echo "git push"',
    "echo 'run git push when ready'",
    "grep -r 'git push' docs",
    "git pull --rebase",
    "git fetch origin",
    "git remote add origin git@github.com:me/x.git",
    "gh pr list",
    "gh pr view 3",
    "gh pr checkout 3",
    "gh repo view",
    "gh repo clone me/x",
    "gh release list",
    "gh release download v1",
    "gh api repos/me/x",
    "gh api -X GET repos/me/x/pulls",
    "gh auth status",
    "# git push",
    "cat push.txt",
    "git stash push -m wip",
  ])("not a publish: %s", (text) => {
    expect(what(text)).toEqual([])
  })

  test("several in one line are all reported", () => {
    expect(what("git push && gh pr create --fill")).toEqual(["git push", "gh pr create"])
  })

  test("the run switches", () => {
    expect(Publish.allowedByEnv({})).toBe(false)
    expect(Publish.allowedByEnv({ RAFIKICODE_ALLOW_PUSH: "1" })).toBe(true)
    expect(Publish.allowedByEnv({ RAFIKICODE_ALLOW_PUSH: "true" })).toBe(true)
    expect(Publish.allowedByEnv({ RAFIKICODE_ALLOW_PUSH: "0" })).toBe(false)
    expect(Publish.allowedByConfig({ publish: "allow" })).toBe(true)
    expect(Publish.allowedByConfig({ "*": "allow", bash: "allow" })).toBe(false)
    expect(Publish.allowedByConfig("allow")).toBe(false)
    expect(Publish.allowedByConfig({ publish: "ask" })).toBe(false)
  })
})
