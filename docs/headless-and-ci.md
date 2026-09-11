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

`RAFIKICODE_API_KEY` takes precedence over any credential stored by `rafikicode login`. `rafikicode whoami --offline` confirms which credential is in use without printing the key.

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
| `--auto` | approve tool permissions that are not explicitly denied; without it a job that needs to edit files stalls waiting for a person. Grant this only to jobs that run in a disposable checkout |
| `--model rafiki/rafiki-pro` | choose the tier for this run (default `rafiki/rafiki-fast`) |
| `--dir PATH` | run in another directory |
| `--title TEXT` | name the session for later `rafikicode session` and `rafikicode export` use |
| `--continue` and `--session ID` | continue an earlier session |
| `-f FILE` | attach a file to the message |

Standard input is read as the message when it is not a terminal, so a script that pipes nothing should redirect `< /dev/null` or pass the message as arguments.

`rafikicode serve --port 4096` starts the HTTP server for editor integrations and long lived automation on the same machine; `rafikicode attach` and `rafikicode run --attach` talk to it.

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

GitHub Actions job that reviews a pull request and posts the result as a check output:

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
