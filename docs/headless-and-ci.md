# Headless and CI

Headless means running `rafikicode` where no person can open a browser: a build server, a pipeline job, a cron task, a container. This page covers authentication with an API key, non-interactive usage, exit codes, and what happens when credits run out.

## API keys

`rafikicode login` is the sign in for terminals people sit at: it needs a person to approve a code in a browser. Machines use an API key instead. Create one in the Rafiki AI console:

1. Open [console.rafikiai.io/keys](https://console.rafikiai.io/keys) and sign in with your Rafiki AI account.
2. Create a key, tick the Rafiki Code option, give it a name that identifies the machine or pipeline, and set a budget. Keys created without the Rafiki Code option are not billed through Rafiki Code, so always tick it for keys you use with `rafikicode`. The budget caps what this key can spend from the credits in your Rafiki AI account; a key never spends more than the account holds.
3. Copy the key. It is shown once.

Put it in the environment of the job:

```bash
export RAFIKICODE_API_KEY=...
```

`RAFIKICODE_API_KEY` takes precedence over any credential stored by `rafikicode login`. `rafikicode whoami --offline` confirms which credential is in use without printing the key (`Credential: RAFIKICODE_API_KEY (environment)`), and `rafikicode doctor` checks the whole chain (see below).

The installer puts `rafikicode` on the PATH through `~/.bashrc`, which non-interactive shells do not read. In cron, CI steps and `ssh host "command"`, call `~/.rafikicode/bin/rafikicode` by its full path or add the directory to the PATH in the job.

Store the key in the secret store of your CI system, never in the repository. Revoke it from the same page of the Rafiki AI console when the machine is retired; the next request fails with a clear message.

`rafikicode login` refuses to start where no terminal is attached (exit code 2, `No terminal is attached, so the browser sign-in is not available.`), and while `RAFIKICODE_API_KEY` is set (exit code 2).

## Non-interactive runs

`rafikicode run` takes the task as arguments, prints the result, and exits:

```bash
rafikicode run "update the changelog for release 1.4.0 from the commits since the last tag"
```

After the answer, `run` prints one `Task:` line on standard error: the tier of each turn, the requests and tokens, what the key spent during the task by the gateway's count, the key's budget and the credits left (see [What a task costs](./cost.md)). Standard output carries the answer only, and `--format json` prints no such line.

Flags that matter in automation, all listed by `rafikicode run --help`:

| flag | effect |
|---|---|
| `--format json` | emit raw JSON events instead of formatted text, one per line, for machines to parse |
| `--auto` | approve tool permissions that ask (the shell in headless runs, reads of `.env` files, paths outside the workspace) unless they are explicitly denied; without it such a request is rejected and the task continues without it. Grant this only to jobs that run in a disposable checkout |
| `--allow-push` | let this run publish code: `git push` in any form, `gh pr create`, `gh repo create`, `gh release`. Without it such a command is refused, `--auto` or not. See [Pushing code from a run](#pushing-code-from-a-run) |
| `--model rafiki/rafiki-pro` | choose the tier for this run (default `rafiki/rafiki-fast`) |
| `--dir PATH` | run in another directory |
| `--title TEXT` | name the session for later `rafikicode session` and `rafikicode export` use |
| `--continue` (or `--resume`) and `--session ID` | continue an earlier session, including one whose run was killed or lost its connection |
| `-f FILE` | attach a file to the message |

Standard input is read as the message when it is not a terminal, so a script that pipes nothing should redirect `< /dev/null` or pass the message as arguments.

`rafikicode serve --port 4096` starts the HTTP server for editor integrations and long lived automation on the same machine; `rafikicode attach` and `rafikicode run --attach` talk to it. The server can run commands and read files as you, including the key, so it always requires a password. Set one with `RAFIKICODE_SERVER_PASSWORD`. Without one, a server on `127.0.0.1`, `::1` or `localhost` makes a random password and stores it in `~/.rafikicode/servers/<port>.json` (mode 0600, removed when the server exits), and any other address is refused (exit code 2). See [Server files](./configuration.md#server-files). The server uses basic authentication with the user name `rafikicode` (change it with `RAFIKICODE_SERVER_USERNAME`). The upstream names `OPENCODE_SERVER_PASSWORD` and `OPENCODE_SERVER_USERNAME` still work.

```bash
export RAFIKICODE_SERVER_PASSWORD="$(openssl rand -hex 24)"
rafikicode serve --port 4096 &
rafikicode run --attach http://127.0.0.1:4096 "summarize the README" < /dev/null
curl -u "rafikicode:$RAFIKICODE_SERVER_PASSWORD" http://127.0.0.1:4096/doc
```

Without a password of your own, on the same machine and as the same user (the `curl` line uses `jq`):

```bash
rafikicode serve --port 4096 &
rafikicode run --attach http://127.0.0.1:4096 "summarize the README" < /dev/null
curl -u "rafikicode:$(jq -r .password ~/.rafikicode/servers/4096.json)" http://127.0.0.1:4096/doc
```

`run --attach` and `attach` read the password from `--password` or `RAFIKICODE_SERVER_PASSWORD` (and the user name from `--username`). When neither is given and the address is a loopback one, they read the server file for that port, if it is yours, private and its server process is running; a file whose server is gone is removed. A wrong or missing password stops the run with `The rafikicode server at <url> needs a password` or `... refused the password` and exit code 2; an address where no server answers stops it with exit code 4. In 0.1.1, `run --attach` printed no answer and exited 0, and a missing password was reported as `Session not found`. In 0.1.1, `serve` and `web` on `127.0.0.1` had no password unless you set one.

## Shell commands in headless runs

A run is *headless* when nobody can answer a question: `CI` is set (and not `0` or `false`), `GITHUB_ACTIONS` is `true`, or `rafikicode run` has no terminal on standard input or output.

Your own run without a terminal (a script, a container, `ssh host rafikicode run ...`) keeps the default permissions: tools run inside the directory it was started in, so `rafikicode run "create a calculator web page in index.html"` in an empty directory writes the file. Paths outside that directory still ask, and `rafikicode run` rejects a question nobody can answer.

A CI job is different: a prompt injection in a README, an issue or a diff can ask the model to run a command, and the job's environment holds the key and usually other secrets, so when `CI` or `GITHUB_ACTIONS` is set:

- The shell tool asks before every command, and `rafikicode run` rejects a question nobody can answer. The rejection is printed (`permission requested: bash (...); auto-rejecting`) with a one line hint naming `--auto` and `~/.rafikicode/config.json`, the command does not run, and the model continues without it. When every tool call of a run was rejected, the run exits 1.

In every headless run, a project config in an untrusted workspace grants nothing: `permission` entries that allow anything (`bash`, `external_directory`, `edit`, `read` and the rest) in `rafikicode.json`, `opencode.json`, agent settings or agent Markdown files are ignored with a warning. Entries that ask or deny still apply.

To let a job run commands, say so from a place the repository does not control:

| way | example |
|---|---|
| `--auto` on the run | `rafikicode run --auto "refresh the lockfile"` approves every question that is not explicitly denied |
| `OPENCODE_PERMISSION` in the job | `OPENCODE_PERMISSION='{"bash":{"npm test":"allow","*":"deny"}}'` |
| your own config | `{"permission":{"bash":"allow","edit":"allow","external_directory":"allow"}}` in `~/.rafikicode/config.json` on the machine |
| trust the workspace | `RAFIKICODE_TRUST_WORKSPACE=1` in the job, or `rafikicode trust` on a long lived machine; the repository's own permission settings then apply |

An untrusted workspace also loads no project plugins, custom tools or provider packages, and in headless runs starts none of its local MCP servers, formatters or language servers. See [workspace trust](security/workspace-trust.md) for the full rules. The pull request review action needs none of these: it denies edits, shell commands and web fetches explicitly and reviews an untrusted checkout.

## Pushing code from a run

A command that publishes code is never run without a yes from you. This covers `git push` in every form (force pushes, `git -C dir push`, a push inside `&&` lists, `bash -c` strings, after `env`, `sudo` or `VAR=value` prefixes, and git aliases that expand to a push), `gh pr create`, `gh pr merge`, `gh repo create`, `gh release` commands that change a release, `gh gist create` and `gh api` calls that write. In the terminal interface it is asked every time, even when shell commands are allowed, and the question has no "Allow always".

`rafikicode run` cannot ask, so it refuses such a command, with `--auto` too, and prints:

```text
! refused to publish code: git push (git push origin main)
rafikicode run does not publish code unless the run allows it: rerun with --allow-push, set RAFIKICODE_ALLOW_PUSH=1, or put "permission": { "publish": "allow" } in the config of this CI job.
```

A job that is meant to push allows it in one of these ways:

| way | example |
|---|---|
| the flag | `rafikicode run --allow-push "tag the release and push it"` |
| the environment | `RAFIKICODE_ALLOW_PUSH=1` in the job |
| your own config | `{"permission":{"publish":"allow"}}` in `~/.rafikicode/config.json`, or in `OPENCODE_PERMISSION` |

A wildcard such as `"permission": "allow"` or `{"bash": "allow"}` does not allow pushes; only a `publish` entry does. A repository's own config cannot allow them unless you trust the workspace. `{"permission":{"publish":"deny"}}` refuses them everywhere without a question. The check reads the command line, so a script or program that pushes by itself is not seen: keep credentials that can push out of jobs that should not.

## Checking a machine with doctor

`rafikicode doctor` runs the checks a headless job depends on and prints one line each: `ok`, `WARN` with a fix hint and a note on the line below, `FAIL` with a fix hint, or `skip` when an earlier check makes it moot. It ends with `All checks passed`, naming the warnings when there are any, or `N checks need attention, see the lines marked FAIL.` With a key created in the Rafiki AI console, in a checkout you have not trusted:

```text
ok    config      ~/.rafikicode/config.json not created yet, built in defaults apply
ok    project     no project configuration in this directory or above it
WARN  trust       /srv/build/api is not trusted. Fix: Run rafikicode trust /srv/build/api.
                  Project plugins, custom tools, local MCP servers, formatters, language servers and permission rules declared in this directory are not loaded.
ok    credential  RAFIKICODE_API_KEY from the environment
ok    gateway     https://gateway.rafikiai.io answered in 134 ms
ok    key         key rafikicode-..., spent 0.1568 USD of 2.5 USD budget, expires 2026-10-13T12:34:43.455000+00:00
ok    tiers       rafiki-fast, rafiki-pro, rafiki-max
ok    console     https://console.rafikiai.io, account ...
ok    path        rafikicode resolves to /usr/local/bin/rafikicode (a link to ~/.rafikicode/bin/rafikicode), the binary running this check
ok    version     rafikicode ..., stable channel, installed by the installer script, rafikicode update applies
```

The home directory is shortened to `~`, and the version number and the account details to `...`. With no key at all the `credential` line reads `FAIL  credential  none. Fix: Run rafikicode login, or set RAFIKICODE_API_KEY on servers and in CI.`, the `key` and `tiers` lines are skipped, and `doctor` exits 1. A key that works at the gateway but was not created in the Rafiki AI console gives `WARN  console ... does not know this key (401)`, and `doctor` still exits 0; see [Troubleshooting](./troubleshooting.md#keys-and-credits). The `trust` line reads `ok` once the job sets `RAFIKICODE_TRUST_WORKSPACE=1` or the machine has run `rafikicode trust`.

The checks, in order:

| line | what it verifies |
|---|---|
| `config` | `~/.rafikicode/config.json` is absent (built in defaults apply), or readable, valid JSON with comments allowed, and accepted by the same decoder a session uses; the `model` it sets is shown, with a note when that model is outside the gateway. A file that cannot be read, is not JSON, is not a JSON object, or does not match the configuration schema fails here, and the fix names the fields and the schema |
| `project` | the project configuration a session started in this directory would load, each file checked against that same decoder: `rafikicode.json`, `rafikicode.jsonc`, `opencode.json` and `opencode.jsonc` from here up to the repository root, plus the same files under `.rafikicode/` and `.opencode/`, listed in the order they merge. A file a session would refuse is named here instead of stopping the session at start. `skip` when `RAFIKICODE_DISABLE_PROJECT_CONFIG` is set, because then nothing loads from the working tree |
| `trust` | whether this directory is trusted and by what: `RAFIKICODE_TRUST_WORKSPACE` for this run, or the stored list in `~/.rafikicode/trusted-workspaces.json`. An untrusted directory is a `WARN`, not a failure, and the note says what it costs: the project plugins, custom tools, local MCP servers, formatters, language servers and permission rules the directory declares are not loaded. See [workspace trust](security/workspace-trust.md) |
| `credential` | which credential a run would use: `RAFIKICODE_API_KEY`, a stored sign-in, or none. A stored browser sign-in is reported as refused when `CI` is set, and so is a credential file other users can read or write |
| `gateway` | the gateway answers its liveness probe, with the round trip time |
| `key` | the gateway knows the key: alias, spend, budget and expiry as numbers and dates. A revoked key, a spent budget or an expired key fail here. A key made in the Rafiki AI console without the Rafiki Code option gives `WARN` (exit code still 0): create one with the option ticked, or run `rafikicode login` |
| `tiers` | which Rafiki tiers (`rafiki-fast`, `rafiki-pro`) the key may use |
| `console` | the Rafiki AI console answers, and with a key, the account and its credit balance |
| `path` | the name your shell resolves `rafikicode` to is the binary running this check, with symbolic links resolved on both sides, so the link the installer makes into a `PATH` directory is the normal passing case. A second copy earlier on `PATH`, or a stale link from an older install, fails here and the fix prints both paths. A launcher script put on `PATH` by a package manager or a version manager is a `WARN`, because nothing is broken. `skip` in a source checkout, where the process runs from `bun` and there is nothing to compare |
| `version` | the installed version, its update channel, and how it was installed |

The exit code is 0 when every line is `ok`, `WARN` or `skip`, 4 when a failed line is a network failure, and 1 otherwise, so a pipeline can run it as a first step and stop before spending anything. When the gateway cannot be reached, the key and tier lines are skipped instead of waiting on the same gateway again. `--timeout N` sets the seconds to wait for each network check (default 8). The key value is never printed. Set `RAFIKICODE_GATEWAY_URL` or `RAFIKICODE_CONSOLE_URL` to check a local test server instead; the fix hints name the variable when it is set.

## Exit codes

The sign-in commands (`login`, `logout`, `whoami`) use a fixed table so scripts can branch on the result:

| code | meaning |
|---|---|
| 0 | success |
| 1 | the request was refused (for example the sign-in was denied in the browser) |
| 2 | usage: not signed in, or a browser sign-in was attempted where no terminal is attached |
| 3 | credits or key budget spent |
| 4 | network problem reaching the Rafiki AI console or the gateway |
| 5 | internal error |
| 6 | this machine or this build cannot run `rafikicode`: a library that cannot be loaded, a processor without the instructions the build needs, a C library mismatch, no directory it may write to |
| 7 | `rafikicode` runs on this machine, but this terminal cannot host the full screen interface. `rafikicode run` works |

6 and 7 are the startup codes: an installer or a job can tell "this machine cannot run it" (6) and "this terminal cannot draw it" (7) from "not signed in" (2) without reading the message. Both print what they think the cause is, one command to try, and the original error under `Original error:`; `--print-logs` adds the full error and its stack. See [When it will not start](./troubleshooting.md#when-it-will-not-start).

`rafikicode run` exits 0 when the task completes. When the gateway refuses a request it uses the same table: 2 for a revoked or expired key or a tier the key may not use, 3 when the key's budget or the account's credits are spent, 4 when the gateway cannot be reached. Other failures exit 1.

A run stopped from outside exits with its own code: 143 on `SIGTERM` (what `timeout` and most job runners send at a time limit) and 130 on `SIGINT` (Ctrl-c). Before it exits, the turn in progress is stopped the way the interface stops it, the session is written to storage, and one line names it: `Stopped by SIGTERM. The session is saved: rafikicode export <session id>`. So a job can still export the transcript of a run it had to stop. The `Task:` line is printed too, marked partial (`Task (partial, stopped by SIGTERM): ...`), with the spend the gateway reports for the key at that moment; a run that ends with an error marks it `partial, ended with an error`. A request cut short may still be counted on the key after the line is printed. A second signal, or a stop that takes longer than ten seconds, exits at once with the same code.

## Network access in headless runs

A run needs the gateway (`gateway.rafikiai.io`) and nothing else:

- The Rafiki AI console (`console.rafikiai.io`) is asked for the key's spend and the credits left, for the summary line after the answer. When it cannot be reached, the line says less and the run is otherwise unchanged.
- No model catalogue is fetched: the Rafiki tiers are built in.
- No package is installed unless a configuration folder holds plugins or custom tools that need one.
- The search tools use ripgrep (`rg`) when it is on the `PATH` or was downloaded earlier; otherwise it is downloaded once from GitHub. When that download fails, the built-in search takes over and one line says so: it is slower and does not read `.gitignore`. Install ripgrep on a machine without access to GitHub to keep the faster search.

## Budget exhaustion

Every key has a budget, and your Rafiki AI account has a credit balance. When either is spent, the gateway refuses the next request with a budget exceeded error and the run stops. Nothing is charged for the refused request. To continue:

- add credits to your Rafiki AI account in the Rafiki AI console, or
- raise the key's budget on the key page, or
- point the job at a different key.

A refused request from a revoked or expired key is reported the same way with a message naming the cause. API keys do not refresh themselves; give them a long enough lifetime for the job, or replace them from the Rafiki AI console.

## Examples

Pull request review in GitHub Actions is packaged as a composite action in this repository, `.github/actions/rafikicode-review`, with an example workflow next to it; see [Pull request review](./review-recipe.md). The hand written job below shows the same idea in plain steps for other CI systems:

```yaml
name: rafikicode review
on:
  pull_request:

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Install rafikicode
        run: |
          curl -fsSL https://get.rafikiai.io | bash
          echo "$HOME/.rafikicode/bin" >> "$GITHUB_PATH"
      - name: Review the change
        env:
          RAFIKICODE_API_KEY: ${{ secrets.RAFIKICODE_API_KEY }}
        run: |
          rafikicode doctor
          rafikicode run --format json \
            "review the diff between origin/${{ github.base_ref }} and HEAD; list bugs and risky changes" \
            < /dev/null > review.jsonl
      - uses: actions/upload-artifact@v4
        with:
          name: review
          path: review.jsonl
```

A nightly cron entry on a server that keeps a dependency changelog current:

```cron
# m h dom mon dow  command
0 2 * * *  cd /srv/app && RAFIKICODE_API_KEY=$(cat /etc/rafikicode/key) /root/.rafikicode/bin/rafikicode run --auto "refresh docs/dependencies.md from package.json" < /dev/null >> /var/log/rafikicode-nightly.log 2>&1
```

cron does not read `~/.bashrc`, hence the full path to the binary. Keep the key file readable by the job's user only (`chmod 600`). The log contains the model's output, not the key.
