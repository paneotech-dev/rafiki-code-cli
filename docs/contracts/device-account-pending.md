# Contract: an account that cannot sign in yet

Status: the CLI side is implemented (`packages/opencode/src/rafiki/device-flow.ts`). The Rafiki AI console side is not implemented yet.

## Why

A person whose account is new opens the approval page that `rafikicode login` prints, signs in, and is sent to the page that says the account is waiting for approval, or for email verification. The device code stays pending, so the CLI kept polling for the code's ten minutes and then said only that the code expired. Neither screen connected the two.

## The answer

When the person who opened the approval page for a device code has an account that cannot approve it yet (email not verified, or not approved), the console marks that device code, and the next poll of `POST /api/v1/device/token` for it answers:

```json
{
  "error": {
    "message": "This account is waiting for email verification or approval.",
    "type": "account_pending",
    "code": "account_pending"
  }
}
```

with status 400, in the same envelope as the other device flow errors. The answer is final for that device code, like `access_denied`.

## What the CLI does

- On `account_pending` it stops at once with exit code 2 and says that the account is waiting for email verification or approval, and to run `rafikicode login` again once it is approved.
- Against a console that does not send it yet, the CLI says once, after two minutes of `authorization_pending`, that a new account may still be waiting for verification or approval, and the expiry message says the same.
