# Provider scope

Status: implemented on the `wp/2-console-only` branch (after 0.1.1). The escape hatch described below is off; whether it should ever be turned on is an open product decision (see [Decision still open](#decision-still-open)).

A *provider* is a service that answers model requests. The upstream project can talk to many (OpenAI, Anthropic, local servers and others). `rafikicode` is the terminal surface of Rafiki Code, so the official binary talks to one provider only: `rafiki`, the Rafiki gateway, with the models `rafiki-fast`, `rafiki-pro` and `rafiki-max`. Every request is then metered against your Rafiki Console wallet, and support has one path to look at.

## What rafikicode does

| where | behaviour |
|---|---|
| Provider list (`rafikicode models`, the model picker, `rafikicode acp`, `rafikicode serve`) | only `rafiki` models, even when keys for other providers are set in the environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and so on) or stored by an earlier install |
| `enabled_providers` in any configuration (`~/.rafikicode/config.json`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, managed configuration, project files) | ignored, one warning line; the list is always `["rafiki"]` |
| `provider` entries for other providers | loaded, never offered |
| `model`, `small_model`, `agent.<name>.model` or `mode.<name>.model` naming another provider | ignored, one warning line; the Rafiki default applies |
| `--model` naming another provider, in `run` or the terminal interface | the command stops before any session with `rafikicode runs on Rafiki models only (rafiki-fast, rafiki-pro, rafiki-max). Run rafikicode models to see them.` and exit code 2 |
| `rafikicode providers` and its alias `rafikicode auth` | hidden from help; every form prints where the Rafiki key comes from and exits 2 |
| No Rafiki key and no sign in, `run` or the terminal interface | stops before any session with the message below and exit code 2; `run --attach` to a running server is not affected |
| No Rafiki key and no sign in, `rafikicode acp` | the agent starts and answers `initialize`, so the editor can offer its sign in action; `authenticate`, `session/new` and `session/prompt` answer the ACP error `auth_required` (code -32000) with the message below |

The message without a key:

```text
Rafiki Code needs a Rafiki Console account. Create one at https://console.rafikiai.io, then run: rafikicode login
On a server or in CI, create a server key at https://console.rafikiai.io/keys and set RAFIKICODE_API_KEY.
```

The ACP sign in method is named `rafikicode-login` (the upstream name `opencode-login` is still accepted by `authenticate`). Its terminal command is the absolute path of the running `rafikicode` binary, because editors started from a desktop launcher often do not have the shell `PATH`.

## What this is not

This is product scope, not a security control. `rafikicode` is open source under the MIT licence: anyone can rebuild it without these checks and point it anywhere. What keeps Rafiki inference for Rafiki Console accounts is on the server: the gateway accepts only keys it issued, and only the Console issues keys. A rebuilt client without a Console key can only use the user's own providers, which costs Rafiki nothing.

## The escape hatch

There is exactly one switch, `Brand.providers.userOverride` in `packages/core/src/brand/brand.ts`, a build time constant. It is `false` in the official build. When `true`:

- `enabled_providers` and `disabled_providers` from user level configuration are honoured (project files still cannot set `enabled_providers`), so a developer can add a local model server;
- `rafikicode providers` is registered again;
- `run` and the terminal interface start without a Rafiki key, and only a `rafiki` model run without one gets the message above.

There is no environment variable or configuration key that turns it on in a released binary. The test suites use `RAFIKICODE_TEST_PROVIDER_SCOPE=off`, which only a run from source honours; every built binary ignores it.

## Decision still open

Whether power users may widen the scope in the official binary (memo D5, `platform/docs/ide-and-console-lock-v1.md`). Options:

1. Keep the switch off (current): one supported path, every request metered, no local models in the official binary.
2. Turn it on: developers can add local or own key providers in their user configuration; those requests are outside Rafiki support and are not metered by the wallet.
3. Turn it on only for a separate developer build channel.
