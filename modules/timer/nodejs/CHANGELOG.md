# @telorun/timer

## 0.1.1

### Patch Changes

- 95f168e: Use the SDK's shared `tryParseDurationMs` helper instead of a local duration parser. No behavioural change.

## 0.1.0

### Minor Changes

- e3146f3: Add the `timer` module with `Timer.Delay` — a declarative, cancellation-aware wait. `Timer.Delay` is a `Telo.Invocable` that waits a `duration` (`"250ms"`, `"2s"`, `"1.5m"`, `"1h"`), then completes, optionally echoing a `value` through unchanged so it composes mid-pipeline. The wait honors the invocation's cancellation token, so a client disconnect or deadline clears the pending timer and fails with `ERR_INVOKE_CANCELLED` instead of holding work open.
