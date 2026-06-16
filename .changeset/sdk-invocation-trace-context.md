---
"@telorun/sdk": minor
---

sdk: `InvokeContext` gains optional `invocationId` + `parentInvocationId` (the trace correlation a controller can read while a debug consumer is attached). `EmitEvent` gains an optional `metadata` argument, and a new `Tracer` type + `EvaluationContext.tracer` slot expose the kernel's invocation tracer. All additive — existing call sites are unaffected.
