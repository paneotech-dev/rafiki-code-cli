# Idempotency key contract

Status: the client half is implemented. The gateway half is specified here and is not implemented. Until it is, the header is sent and has no effect on what is charged.

## Purpose

A model request can be charged without its answer reaching the user: the connection drops after the gateway has started or finished the work, and the program sends the request again. This contract lets the gateway side recognise the second request as the same piece of work and charge it once.

An idempotency key is a value the client attaches to a request so that the server can tell a repeat of that request from a new one.

## What the client sends

On every `POST /v1/chat/completions` that belongs to a task step, `rafikicode` sends:

```text
Idempotency-Key: <step id>
```

- The step id is the identifier of the stored message that holds the model's reply for that step. It starts with `msg_`, is 30 characters long, printable ASCII, unique per step on the machine that made it, and carries no user content.
- The key identifies one logical request: one step of one session. The session is named by the `X-Session-Id` header that is already sent.
- **Same key:** the request is sent again with a byte for byte identical body because the earlier attempt failed before any text or any complete tool call had arrived (connection refused, connection reset, time out, a stream cut at its very start, an HTTP 5xx or 429 answer).
- **New key:** every other request. In particular, after a stream is cut and partial output was received, the program does not repeat the request: it sends a different request (the partial output is included as history and the model is asked to continue) under a new key.
- A request that summarises a long session is a step and carries a key. The request that names a session carries none.

The client never sends two different bodies under one key. A server that sees that may answer HTTP 422.

## What the gateway side must do

Scope: the pair (API key, `Idempotency-Key`), kept for at least 24 hours.

1. **Record.** Store the key with the usage record of the request (for LiteLLM, in the request metadata that reaches the spend log and the usage collector).
2. **Charge once.** When more than one usage record carries the same pair, the user is charged for at most one of them: the one that completed. Records of attempts that failed or were cut (status 499 or an error) under a key that later completed are not charged to the user. If no attempt completed, at most one attempt is charged.
3. **Replay (optional, preferred).** When a request arrives under a pair whose earlier attempt completed with HTTP 200, answer with the stored response (same content, same usage figures) instead of calling the provider again, and mark the usage record as a replay with zero cost. Error answers are never stored or replayed.
4. **In flight.** When a request arrives under a pair whose earlier attempt is still running, either wait for it and proceed as in 3, or answer HTTP 409 with `Retry-After`. The client retries a 409 up to five times and waits for `Retry-After` when it is given.
5. **No key.** A request without the header is handled as today.

Either 2 alone (in the usage collector, no gateway change to the request path) or 2 with 3 (in the gateway) satisfies this contract. With 2 alone the provider is still paid twice for a repeated request and the operator carries that cost.

## What this does not cover

- **A continuation is a new request.** After a cut stream, the first request is charged by the provider for its input and for the output generated before the cut, and the continuation is charged for its own input (which contains the partial output) and for the remaining output. The output is generated once, the input is sent twice. Whether the input of the cut request is waived is a pricing decision for the gateway side; the gateway records a cut request as a client disconnect (status 499 in LiteLLM).
- **Tool calls.** A tool call that completed before a cut is not requested again by the client, so there is no second charge to avoid for it.

## Evidence for "not implemented"

Read from the installed gateway (LiteLLM 1.93.0) and its configuration, without changing either:

- No code under `litellm/proxy` reads an `Idempotency-Key` header; the word appears only in unrelated management endpoints.
- `litellm/proxy/common_request_processing.py` takes `x-litellm-call-id` from the request as the call id when present. The spend log row id is the provider's response id, and the call id only when there is none (`get_spend_logs_id` in `litellm/proxy/spend_tracking/spend_tracking_utils.py`), so two attempts normally produce two rows. No lookup of an earlier row by call id before spend is added was found.
- The response cache in the gateway configuration is switched off for the Rafiki Code tiers (`no-cache`, `no-store` on each tier), and by the configuration's own comment it stores only completed, non streamed answers, so it does not deduplicate these requests either.
