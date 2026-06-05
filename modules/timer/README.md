# Timer

Time-based primitives for Telo manifests. `Timer.Delay` waits for a duration, then completes — usable as a `Run.Sequence` step, an HTTP handler, or any invoke target.

## Why use this

- **Declarative wait** — express a pause as a resource (`"250ms"`, `"2s"`, `"1.5m"`, `"1h"`) instead of inline `JS.Script` `setTimeout`.
- **Composable** — echoes an optional `value` through unchanged, so it drops into the middle of a pipeline (delay-then-forward).
- **Cancellation-aware** — if the invocation is cancelled (client disconnect, deadline), the pending timer is cleared and the call fails with `ERR_INVOKE_CANCELLED` instead of holding work open.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Timer.Delay` | Wait `duration`, then complete (optionally echoing `value`). |

## Example

```yaml
kind: Telo.Application
metadata: { name: paced-pipeline, version: 1.0.0 }
imports:
  Timer: std/timer@latest
  Run: std/run@latest
---
kind: Run.Sequence
metadata: { name: Paced }
steps:
  - name: Wait
    inputs: { duration: "2s" }
    invoke: { kind: Timer.Delay }
  - name: Next
    # ... runs after the 2s delay
```
