# rafikicode

The Rafiki Code terminal coding agent.

```bash
npm install -g rafikicode
rafikicode --version
```

This package holds no binary. When it is installed it downloads the release
archive for your machine from the GitHub release of the same version,
checks it against the SHA-256 recorded in this package, and unpacks it next to
the launcher. If your package manager skips install scripts, the same download
runs the first time you start `rafikicode`.

It needs Node.js 18 or later and the `tar` command, which Linux, macOS and
Windows 10 and later all include.

Other ways to install, and how updates work:
https://github.com/paneotech-dev/rafiki-code-cli/blob/main/docs/install.md

The licence and notice are in `LICENSE` and `NOTICE` in this package, and
`rafikicode licenses` prints them.
