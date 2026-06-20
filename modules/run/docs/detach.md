---
sidebar_label: Run.Detach
---

# Run.Detach

`Run.Detach` is the generic fire-and-forget primitive: it dispatches its wrapped `invoke:` target in the background (via the SDK's `runDetached`) and returns immediately, off the caller's response path. Use it for side effects that shouldn't add latency and can fail independently — audit writes, notifications, analytics, cache warming.

## How it works

`Run.Detach` is itself a decorator — it wraps an invocable via the standard `invoke:` field. On invocation it dispatches `target.invoke(inputs)` detached and returns `{ detached: true }` without awaiting. No pool to declare: the kernel tracks the task against the `Run.Detach` resource and **drains it when that resource tears down** (bounded, so shutdown can't hang), and routes a failure to the EventBus (the caller never sees it).

## Fields

| Field | Required | Description |
| --- | --- | --- |
| `invoke` | yes | The invocable dispatched in the background. |

## Example

```yaml
kind: Run.Detach
metadata: { name: RecordClick }
invoke: !ref InsertClick     # any Telo.Invocable
```

Invoking `RecordClick` with the inner's inputs returns immediately; the wrapped `InsertClick` runs detached. Inputs are forwarded verbatim to the target.
