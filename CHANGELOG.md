# Changelog

- Network resilience: a model response cut by a dropped connection is continued from the text or the tool call that had arrived instead of being requested again, connection errors in the middle of a task are retried with backoff and jitter for a window (`RAFIKICODE_RETRY_WINDOW`, default 2 minutes), `rafikicode --resume` reopens the last session and repairs a step left open by a killed process so undo restores its files, and every task request carries an `Idempotency-Key` header (the gateway side is specified in `docs/contracts/idempotency-key.md` and is not implemented yet).
