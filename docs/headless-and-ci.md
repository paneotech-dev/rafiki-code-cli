# Headless and CI

Headless means running `rafikicode` where no person can open a browser: a build server, a pipeline job, a cron task, a container. This page covers authentication with a server key, non-interactive usage, exit codes, and what happens when the budget runs out.

## Server keys

The browser sign-in (`rafikicode login`) is for terminals people sit at. For machines, create a server key in Rafiki Console:

1. Open [console.rafikiai.io/keys](https://console.rafikiai.io/keys).
2. Create a key of the kind "server", give it a name that identifies the machine or pipeline, and set a budget. The budget caps what this key can spend from your wallet; a key never spends more than the wallet holds.
3. Copy the key once. It is shown once and stored hashed.

Put it in the environment of the job:

```bash
export RAFIKICODE_API_KEY=...
```

`RAFIKICODE_API_KEY` takes precedence over any credential stored by `rafikicode login`. `rafikicode whoami --offline` confirms which credential is in use without printing the key, and `rafikicode doctor` checks the whole chain (see below).

Store the key in the secret store of your CI system, never in the repository. Revoke it from the same Console page when the machine is retired; the next request fails immediately with a clear message.

## Non-interactive runs

`rafikicode run` takes the task as arguments, prints the result, and exits:

```bash
rafikicode run "update the changelog for release 1.4.0 from the commits since the last tag"
```

Flags that matter in automation, all listed by `rafikicode run --help`:

| flag | effect |
|---|---|
| `--format json` | emit raw JSON events instead of formatted text, one per line, for machines to parse |
| `--auto` | approve tool permissions that ask (the shell in headless runs, reads of `.env` files, paths outside the workspace) unless they are explicitly denied; without it such a request is rejected and the task continues without it. Grant this only to jobs that run in a disposable checkout |
| `--model rafiki/rafiki-pro` | choose the tier for this run (default `rafiki/rafiki-fast`) |
| `--dir PATH` | run in another directory |
| `--title TEXT` | name the session for later `rafikicode session` and `rafikicode export` use |
| `--continue` and `--session ID` | continue an earlier session |
| `-f FILE` | attach a file to the message |

Standard input is read as the message when it is not a terminal, so a script that pipes nothing should redirect `< /dev/null` or pass the message as arguments.

`rafikicode serve --port 4096` starts the HTTP server for editor integrations and long lived automation on the same machine; `rafikicode attach` and `rafikicode run --attach` talk to it.

## Shell commands in headless runs

A run is *headless* when nobody can answer a question: `CI` is set (and not `0` or `false`), `GITHUB_ACTIONS` is `true`, or `rafikicode run` has no terminal on standard input or output. A prompt injection in a README, an issue or a diff can ask the model to run a command, and the job's environment holds the key, so in headless runs:

- The shell tool asks before every command, and `rafikicode run` rejects a question nobody can answer. The rejection is printed (`permission requested: bash (...); auto-rejecting`), the command does not run, and the model continues without it.
- A project config in an untrusted workspace cannot change that: `permission` entries that allow `bash` in `rafikicode.json`, `opencode.json`, agent settings or agent Markdown files are ignored with a warning.

To let a job run commands, say so from a place the repository does not control:

| way | example |
|---|---|
| `--auto` on the run | `rafikicode run --auto "refresh the lockfile"` approves every question that is not explicitly denied |
| `OPENCODE_PERMISSION` in the job | `OPENCODE_PERMISSION='{"bash":{"npm test":"allow","*":"deny"}}'` |
| your own config | `"permission": {"bash": "allow"}` in `~/.rafikicode/config.json` on the machine |
| trust the workspace | `RAFIKICODE_TRUST_WORKSPACE=1` in the job, or `rafikicode trust` on a long lived machine; the repository's own permission settings then apply |

An untrusted workspace also loads no project plugins, custom tools or provider packages, and in headless runs starts none of its local MCP servers, formatters or language servers. See [workspace trust](security/workspace-trust.md) for the full rules. The pull request review action needs none of these: it denies edits, shell commands and web fetches explicitly and reviews an untrusted checkout.

## Checking a machine with doctor

`rafikicode doctor` runs the checks a headless job depends on and prints one line each, `ok`, `FAIL` with a fix hint, or `skip` when an earlier check makes it moot:

```text
ok    config      /home/ci/.rafikicode/config.json not created yet, built in defaults apply
ok    credential  RAFIKICODE_API_KEY from the environment
ok    gateway     https://gateway.rafikiai.io answered in 135 ms
ok    key         key ci-review, spent 0.31 USD of 5 USD budget, no expiry
ok    tiers       rafiki-fast, rafiki-pro (not on this key: rafiki-max)
ok    console     https://console.rafikiai.io, account Jane jane@example.com, wallet 12.4 USD available
ok    version     rafikicode 1.2.3, latest channel, installed by the installer script, rafikicode update applies

All checks passed.
```

The checks, in order:

| line | what it verifies |
|---|---|
| `config` | `~/.rafikicode/config.json` is absent (defaults apply) or valid JSON with comments allowed; the default model is shown |
| `credential` | which credential a run would use: `RAFIKICODE_API_KEY`, a stored sign-in, or none. A stored browser sign-in is reported as refused when `CI` is set |
| `gateway` | the gateway answers its liveness probe, with the round trip time |
| `key` | the gateway knows the key: alias, spend, budget and expiry as numbers and dates. A revoked key, a spent budget or an expired key fail here |
| `tiers` | which of `rafiki-fast`, `rafiki-pro`, `rafiki-max` the key may use |
| `console` | Rafiki Console answers, and with a key, the account and wallet balance |
| `version` | the installed version, its update channel, and how it was installed |

The exit code is 0 when every line is `ok`, 4 when a failed line is a network failure, and 1 otherwise, so a pipeline can run it as a first step and stop before spending anything. When the gateway cannot be reached, the key and tier lines are skipped instead of waiting on the same gateway again. `--timeout N` sets the seconds to wait for each network check (default 8). The key value is never printed. Set `RAFIKICODE_GATEWAY_URL` or `RAFIKICODE_CONSOLE_URL` to check a staging or local mock instead of production; the fix hints name the variable when it is set.

## Exit codes

The sign-in commands (`login`, `logout`, `whoami`) use a fixed table so scripts can branch on the result:

| code | meaning |
|---|---|
| 0 | success |
| 1 | the request was refused (for example the sign-in was denied in the browser) |
| 2 | usage: not signed in, or a browser sign-in was attempted where no terminal is attached |
| 3 | wallet or budget problem |
| 4 | network problem reaching the Console |
| 5 | internal error |

`rafikicode run` exits 0 when the task completes and non-zero otherwise.

## Budget exhaustion

Every key has a budget, and the wallet has a balance. When either is spent, the gateway refuses the next request with a budget exceeded error and the run stops. Nothing is charged for the refused request. To continue:

- top up the wallet in Rafiki Console, or
- raise the key's budget on the key page, or
- point the job at a different key.

A refused request from a revoked or expired key is reported the same way with a message naming the cause. Server keys do not refresh themselves; give them a long enough lifetime for the job, or rotate them from the Console.

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

Keep the key file readable by the job's user only (`chmod 600`). The log contains the model's output, not the key.
