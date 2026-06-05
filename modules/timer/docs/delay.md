---
description: "Timer.Delay — a declarative, cancellation-aware wait usable as a Run.Sequence step, an HTTP handler, or any invoke target."
sidebar_label: Timer.Delay
---

# `Timer.Delay`

> Examples below assume this module is imported with an `imports:` entry under alias `Timer`. Kind references (`Timer.Delay`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

`Timer.Delay` waits for a duration, then completes. It's a `Telo.Invocable`, so it composes anywhere an invoke target is accepted — a `Run.Sequence` step, an `Http.Api` route handler, an application `target`.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `duration` | string | yes | How long to wait, as a number + unit: `ms`, `s`, `m`, `h` (e.g. `"250ms"`, `"2s"`, `"1.5m"`, `"1h"`). |
| `value` | any | no | Echoed back unchanged once the delay elapses — a pipeline passthrough. |

## Output

| Field | Type | Description |
| --- | --- | --- |
| `value` | any | The input `value`, returned after the delay (`null` when omitted). |

## Cancellation

The wait honors the invocation's cancellation token. If the call is cancelled while waiting — a client disconnecting from an HTTP request, or a deadline elapsing — the pending timer is cleared and the call fails with `ERR_INVOKE_CANCELLED`, rather than holding the timer (and the work behind it) alive until the duration runs out.

## Examples

Pace a sequence — wait two seconds between steps:

```yaml
kind: Run.Sequence
metadata: { name: Paced }
steps:
  - name: First
    invoke: { kind: Sql.Exec, name: DoWork }
  - name: Wait
    inputs: { duration: "2s" }
    invoke: { kind: Timer.Delay }
  - name: Second
    invoke: { kind: Sql.Exec, name: DoMoreWork }
```

Delay-then-forward — carry a value through the wait:

```yaml
- name: Hold
  inputs:
    duration: "500ms"
    value: "${{ steps.compute.result }}"
  invoke: { kind: Timer.Delay }
- name: Use
  inputs:
    payload: "${{ steps.Hold.result.value }}"
  invoke: { kind: Sql.Exec, name: Persist }
```

A dynamic duration is just CEL on the caller's side — the value reaching `duration` must be a duration string:

```yaml
- name: Backoff
  inputs:
    duration: "${{ string(steps.attempt.result.backoffMs) + 'ms' }}"
  invoke: { kind: Timer.Delay }
```
