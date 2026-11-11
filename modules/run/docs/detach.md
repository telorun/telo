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

The inputs are typed by the target's input contract (the instance's `inputType`, else its kind's): a call it refuses is `CONTRACT_INPUTS_MISMATCH` under `telo check` and `ERR_INPUT_INVALID` at the detach's own dispatch, and a field the contract marks `x-telo-sensitive` is `[redacted]` in the detach's traced inputs. A target with no statically resolvable contract leaves the inputs unconstrained, and its forwarded value is withheld whole from traces.

A stream in the inputs of a detach issued inside a sequence's `with:` run — a scoped resource's streamed reply — keeps that run, and so the resource, alive until the detached target has drained it or ended; a stream the target never reads is cancelled when it ends.
