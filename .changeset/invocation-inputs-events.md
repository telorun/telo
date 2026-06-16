---
"@telorun/kernel": minor
---

kernel: invocation events now carry richer debug data. `<Kind>.<Name>.Invoked` is now `{ inputs, outputs }`, and the failure/cancellation events (`InvokeFailed`, `InvokeRejected`[`.Undeclared`], `InvokeCancelled`) gain an `inputs` field — so a consumer sees what a call was given on both the success and failure paths.

Additionally, a new opt-in **invocation tracer** (`Kernel.setTracing(true)`, flipped on by the CLI debug server while attached) mints a monotonic `invocationId` per call and emits `invocationId` / `parentInvocationId` in event **metadata**, letting a consumer rebuild the call tree. Tracing is off by default and costs nothing — the zero-allocation dispatch fast path is preserved when no consumer is watching.

Existing event fields are unchanged, but note the **exposure expansion**: `inputs` now joins `outputs` in what a `*` event consumer receives and what the CLI's `--debug` writes to `.telo.debug.jsonl`. Payloads are not secret-redacted (the `--inspect` endpoint already warns of this), so an invoke argument carrying a resolved secret — a DB password, an API key — is now persisted where before only outputs were. This is gated on a debug consumer being attached, but it is a real widening of the on-disk surface; redaction driven by the kernel's `secretValues` is a possible follow-up.
