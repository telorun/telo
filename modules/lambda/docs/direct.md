---
sidebar_label: Lambda.Direct
---

# Lambda.Direct

Catch-all handler kind. The `Lambda.Function` event-shape classifier picks `Direct` when no other concrete kind matches, so any synchronous SDK invoke, Step Functions task, EventBridge Scheduler call, or internal admin tool ends up here.

## Shape

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

## Invocation

1. The Function dispatches `{ event, context }` here when classification picks `Direct`.
2. `inputs:` CEL expands against `{ event, context }`. The map keys become the keys passed to the handler.
3. The handler is invoked with the resolved inputs.
4. On success, `returns:` matches the first entry whose `when:` evaluates to `true`. Entries without `when:` are catch-all fallbacks (later entries override earlier matches only if they have explicit `when:`).
5. The matched entry's `body:` (CEL-expanded with `{ event, context, result }` in scope) is returned to the caller (SDK / Step Functions / scheduler).
6. On `InvokeError`, `catches:` matches by `code` first, then `when:`. The matched `body` is returned. If no catch matches, the error propagates to AWS — the SDK caller sees a failed invocation.

## When to use Direct vs HttpApi vs Sqs

| You're handling… | Use |
|---|---|
| API Gateway HTTP API v2 events with `requestContext.http` | `Lambda.HttpApi` |
| SQS `Records[]` events with `eventSource: "aws:sqs"` | `Lambda.Sqs` |
| Synchronous SDK invoke (`lambda.invoke`) | `Lambda.Direct` |
| Step Functions task | `Lambda.Direct` |
| EventBridge Scheduler with no transformation | `Lambda.Direct` |
| Internal admin tooling | `Lambda.Direct` |
| Anything else, or a catch-all in a mixed-source Function | `Lambda.Direct` |

The Function's classifier prefers `HttpApi` / `Sqs` over `Direct` when their structural matches succeed, so listing `Direct` alongside another kind is safe — it only catches what nothing else claims.
