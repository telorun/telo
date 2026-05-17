---
sidebar_label: Lambda.Direct
---

# Lambda.Direct

Working example: [`examples/aws/lambda/direct.yaml`](https://github.com/telorun/telo/blob/main/examples/aws/lambda/direct.yaml).

Use `Lambda.Direct` when your Lambda receives events that don't fit a more specific handler kind:

- Synchronous SDK invokes (`aws lambda invoke`, `lambda:Invoke` from another service, custom clients).
- Step Functions tasks.
- EventBridge Scheduler invocations with no payload transformation.
- Internal admin tooling or ad-hoc RPC.
- A catch-all in a Function that mostly handles HTTP/SQS but occasionally receives unrouted invokes.

`Direct` is safe to list alongside `Lambda.HttpApi` and `Lambda.Sqs` in the same Function — Telo picks the more specific kind whenever it matches, so `Direct` only catches events nothing else claims.

## Minimal example

```yaml
kind: Lambda.Direct
metadata: { name: Worker }
handler: { kind: My.Worker }
inputs:
  payload: !cel "event"
```

The handler is invoked with `{ payload: <the AWS event body> }`. Its return value becomes the Lambda's return value (visible to the SDK caller, Step Functions task output, etc.).

## With response shaping

`returns:` and `catches:` let you reshape the handler's result or render structured errors without touching the handler itself.

```yaml
kind: Lambda.Direct
metadata: { name: Worker }
handler: { kind: My.Worker }
inputs:
  payload: !cel "event"
returns:
  - when: !cel "result.kind == 'ok'"
    body: !cel "result.value"
  - body: !cel '{ status: "unknown" }'
catches:
  - code: VALIDATION_ERROR
    body: !cel '{ error: { code: error.code, message: error.message } }'
```

**Matching rules:**

- `returns[]` entries are walked top-to-bottom on successful handler return. The first entry whose `when:` evaluates to `true` wins; entries without `when:` are catch-all fallbacks (explicit `when` matches always beat catch-alls regardless of order).
- `catches[]` is only consulted when the handler throws an `InvokeError`. The first entry whose `code:` matches and `when:` is truthy wins. If no catch matches, the error propagates to AWS — the caller sees a failed invocation.
- Each matched entry's `body:` is CEL-expanded against `{ event, context, result }` (success) or `{ event, context, error }` (failure) and returned.
- Omitting `returns:` entirely returns the handler's result verbatim.

## CEL context

| Inside | Available |
|---|---|
| `inputs:` | `event`, `context` |
| `returns[].when` / `returns[].body` | `event`, `context`, `result` |
| `catches[].when` / `catches[].body` | `event`, `context`, `error` (with `code`, `message`, `data`) |

## When NOT to use Direct

- API Gateway HTTP API v2 events — use [Lambda.HttpApi](./http-api.md) instead.
- SQS batch events — use [Lambda.Sqs](./sqs.md), which expresses the partial-batch-failure contract.

Direct accepts those events too (it's the catch-all), but you'd be re-implementing the HTTP/SQS-specific bits in your handler.
