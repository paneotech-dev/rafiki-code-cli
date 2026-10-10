# GitHub from the command line

Three things on this page:

- [Put a project on GitHub](#put-a-project-on-github): `/github` in the terminal interface, or `rafikicode github`, takes a folder to a private GitHub repository step by step.
- [Pushes ask first](#pushes-ask-first): the agent never publishes code without your yes.
- [Deploy to a server](#deploy-to-a-server): how to get the code from GitHub onto your own server.

`rafikicode gh` creates branches, commits, pushes, opens pull requests, and reads and comments on issues.

It stores no GitHub credential. Every command shells out to the `git` and `gh` binaries already on your machine and uses the GitHub account `gh` is logged in to. Nothing is written to `~/.rafikicode`, so there is no GitHub token here to leak, expire or rotate. Revoking access is done in one place, with `gh auth logout`.

## Setup

1. Install the GitHub CLI from [cli.github.com](https://cli.github.com).
2. Log it in once:

   ```bash
   gh auth login
   ```

3. Check what `rafikicode` sees:

   ```bash
   rafikicode gh status
   ```

   It prints the repository, the branch, and the GitHub account `gh` is logged in as. `status` never fails for want of `gh`: when `gh` is missing or logged out it reports that as the state, and then names the command that fixes it.

   Only the subcommands that talk to GitHub need `gh`: `pr create`, `pr comment`, `issue list`, `issue view` and `issue comment`. Those stop with the same message and name `gh auth login`. `branch`, `commit` and `push` use `git` alone and work with `gh` absent or logged out, so you can commit and push without it; `push` needs a remote your `git` can already authenticate to, which is the usual case whether or not `gh` is installed.

## Commands

Run them from inside a git repository; `status` is the exception and reports the absence of one. Each command reports what it did, or stops with the first line of output from `git` or `gh`. The `gh` column says whether the GitHub CLI has to be logged in.

| command | what it does | needs `gh` |
|---|---|---|
| `rafikicode gh status` | the repository, the branch, and whether `gh` is logged in | no |
| `rafikicode gh branch <name>` | switches to `<name>`, creating it when it does not exist yet | no |
| `rafikicode gh commit -m "<message>"` | stages every change and commits | no |
| `rafikicode gh push` | pushes the current branch and sets its upstream | no |
| `rafikicode gh pr create --title "<title>" --body "<body>"` | opens a pull request for the current branch | yes |
| `rafikicode gh pr comment <number> --body "<text>"` | comments on a pull request | yes |
| `rafikicode gh issue list` | lists issues, one per line | yes |
| `rafikicode gh issue view <number>` | prints an issue and its comments | yes |
| `rafikicode gh issue comment <number> --body "<text>"` | comments on an issue | yes |

A worked sequence:

```bash
rafikicode gh branch fix/login-redirect
rafikicode gh commit -m "fix: send the login redirect to the requested page"
rafikicode gh push
rafikicode gh pr create --title "Fix the login redirect" --body "Closes #42"
```

## Options worth knowing

- `gh commit --no-stage` commits only what you have already staged, instead of staging the whole work tree.
- `gh push --remote <name>` pushes somewhere other than `origin`.
- `gh push --force-with-lease` overwrites the remote branch only if nobody else has pushed to it since you last fetched. There is no plain `--force`.
- `gh pr create --base <branch>` picks the branch to merge into, and `--draft` opens the pull request as a draft.
- `gh issue list --state open|closed|all` and `--limit <n>` narrow the list.

## Reading the messages

| message | what to do |
|---|---|
| `The GitHub CLI (gh) was not found on your PATH.` | install `gh`, then run `gh auth login`. Only the pull request and issue commands need it |
| `The GitHub CLI (gh) is installed but not logged in.` | run `gh auth login`. Only the pull request and issue commands need it |
| `Could not find a git repository here.` | run the command from inside a git repository |
| `Nothing to commit: the work tree is clean.` | there is nothing staged or changed to commit |
| `HEAD is detached. Switch to a branch before pushing.` | run `rafikicode gh branch <name>` first |

Titles, bodies and commit messages are passed to `git` and `gh` as single arguments without a shell, so quotes, newlines and shell punctuation in them are text and never run as commands.

## Put a project on GitHub

Type `/github` in the terminal interface, or run `rafikicode github` in the project folder. Each step that changes something asks first, shows what it is about to do, and stops at a no:

1. It checks that `git` and the GitHub CLI (`gh`) are installed and that `gh` is signed in (`gh auth status`). When something is missing it says how to fix it on your system and stops:

   | system | install `gh` | install `git` |
   |---|---|---|
   | Windows (PowerShell) | `winget install --id GitHub.cli -e`, then open a new PowerShell window | `winget install --id Git.Git -e` |
   | macOS | `brew install gh` | `xcode-select --install` or `brew install git` |
   | Debian or Ubuntu | `sudo apt install gh` | `sudo apt install git` |
   | Fedora | `sudo dnf install gh` | `sudo dnf install git` |
   | Arch | `sudo pacman -S github-cli` | `sudo pacman -S git` |

   Then sign in once with `gh auth login`: choose GitHub.com, HTTPS, and Login with a web browser. Your GitHub sign-in stays with `gh`; nothing is stored by `rafikicode`.
2. When the folder is not a git repository yet, it offers to create one. It never makes your home folder or the top of a drive a repository.
3. Before anything is committed or pushed, it scans the files that would go to GitHub for secrets: environment files (`.env`, `.env.local`, but not `.env.example`), private keys and certificates (`.pem`, `.key`, `id_rsa`, ...), credential files (`.netrc`), and tokens inside files (GitHub, AWS, Slack, Stripe, Google, GitLab and npm tokens, `sk-` keys, private key blocks). It also checks the names of files in earlier commits. When it finds one it adds the file names to `.gitignore`, lists each finding with its file and line (never the value), says what else to do (for example `git rm --cached .env` for a file that is already committed) and stops. Run it again once they are dealt with. A line that holds a test value rather than a secret can carry the comment `secret-scan: allow`.
4. When there is no commit yet, it adds installed dependency folders (`node_modules`, `.venv`) to `.gitignore` and offers to commit the files as "Initial commit".
5. It suggests a repository name from the folder name, which you can change, and creates a **private** repository with `gh repo create <name> --private`, added as the remote `origin`. A repository that already has an `origin` is pushed there instead.
6. It pushes the branch and shows the repository's address.
7. It offers the next steps: a pull request (opened for you when you are on a branch other than the default one), and deploying to a server.

`rafikicode github` asks in the terminal. Without a terminal (a script, CI) it stops at the first question unless you pass `--yes`, which answers yes to every step:

```bash
rafikicode github --yes --name my-site
```

| option | effect |
|---|---|
| `--yes`, `-y` | answer yes to every step |
| `--name <name>` | the name of the new repository (default: the folder name) |
| `--dir <path>` | the project folder (default: the current folder) |

It exits 0 when the code is on GitHub, 1 when it stopped (something to fix, or a no), and 2 for an invalid `--name`.

## Pushes ask first

The agent can run `git` and `gh` like any other command, but a command that publishes code always asks for your yes in the interface first, even when shell commands are allowed. That covers `git push` in every form (force pushes, `git -C <dir> push`, pushes inside `&&` lists or `bash -c` strings, after `env`, `sudo` or `VAR=value`, and git aliases that expand to a push), `gh pr create`, `gh pr merge`, `gh repo create`, `gh release` commands that change a release, `gh gist create` and `gh api` calls that write. The question shows the command and what it does, and offers Allow once or Reject: there is no "Allow always", so the next push asks again.

`rafikicode run` cannot ask, so it refuses these commands unless the run allows pushes with `--allow-push`, `RAFIKICODE_ALLOW_PUSH=1` or `{"permission":{"publish":"allow"}}` in the config. See [Pushing code from a run](./headless-and-ci.md#pushing-code-from-a-run). `{"permission":{"publish":"deny"}}` refuses them everywhere without a question.

## Deploy to a server

Once the code is on GitHub, there are two good ways to run it on a server you own. Both keep your GitHub sign-in off the server.

### Pull-based deploy (recommended)

The server fetches the code itself, so GitHub never needs a way into the server.

1. On the server, create a key that can only read this one repository:

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/deploy_my_site -N ""
   cat ~/.ssh/deploy_my_site.pub
   ```

2. On GitHub, open the repository, then Settings, Deploy keys, Add deploy key. Paste the public key and leave "Allow write access" off.
3. Clone with that key:

   ```bash
   GIT_SSH_COMMAND="ssh -i ~/.ssh/deploy_my_site -o IdentitiesOnly=yes" git clone git@github.com:YOUR-NAME/my-site.git /srv/my-site
   cd /srv/my-site && git config core.sshCommand "ssh -i ~/.ssh/deploy_my_site -o IdentitiesOnly=yes"
   ```

4. Write a small script that updates and restarts the app, for example `/srv/my-site/deploy.sh`:

   ```bash
   #!/bin/sh
   set -e
   cd /srv/my-site
   git fetch origin main
   [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0
   git reset --hard origin/main
   docker compose up -d --build
   ```

   Replace the last line with what starts your app (`npm ci && systemctl restart my-site`, for example).
5. Run it every few minutes with a systemd timer or cron:

   ```bash
   */5 * * * * /srv/my-site/deploy.sh >> /var/log/my-site-deploy.log 2>&1
   ```

Every push to `main` is live within five minutes. Keep secrets (database passwords, API keys) in an environment file on the server that is not in the repository.

### GitHub Actions over SSH (alternative)

A workflow in the repository connects to the server after each push and runs the same script. It deploys at once, but the server must accept SSH connections from GitHub's runners, and a key that can log in to the server is stored in GitHub as a secret.

1. On the server, create a user for deploys and add a new public key to its `~/.ssh/authorized_keys`.
2. In the repository, open Settings, Secrets and variables, Actions, and add `DEPLOY_HOST`, `DEPLOY_USER` and `DEPLOY_KEY` (the private key).
3. Add `.github/workflows/deploy.yml`:

   ```yaml
   name: deploy
   on:
     push:
       branches: [main]
   jobs:
     deploy:
       runs-on: ubuntu-latest
       steps:
         - name: Run the deploy script on the server
           env:
             KEY: ${{ secrets.DEPLOY_KEY }}
             HOST: ${{ secrets.DEPLOY_HOST }}
             USER: ${{ secrets.DEPLOY_USER }}
           run: |
             install -m 600 /dev/null key && printf '%s\n' "$KEY" > key
             ssh -i key -o StrictHostKeyChecking=accept-new "$USER@$HOST" /srv/my-site/deploy.sh
   ```

Anyone who can change workflows in the repository can use that key, so give the deploy user only what the deploy needs.

## Related

- [Pull request review](./review-recipe.md) reviews a diff and can post the review as a comment.
- [GitHub Action: review every pull request](./github-action.md) runs `rafikicode` on each pull request in CI.
