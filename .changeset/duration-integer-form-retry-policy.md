---
"@telorun/sdk": minor
"@telorun/analyzer": minor
---

A `Telo.Duration` slot reads an integer written in a manifest as that many milliseconds — `initialDelay: 250` and `initialDelay: 250ms` are one duration — at every site its text is decoded: a resource's own configuration, a call's `inputs:`, a schema-derived slot, an import's `variables:` / `secrets:`, a `default:` and a transport's inbound value. The rule is data on the value type's entry (`integerForm: { unit: ms }`), read by the Node and the Rust SDK alike. A digit-only string stays text, and a CEL `int` is not a duration.

The shared retry policy (`telo://manifest#/$defs/RetryPolicy`) takes durations: `initialDelay` / `maxDelay` (250ms / 32s when omitted) and a step's per-attempt `timeout:` are `Telo.Duration` slots, so manifests writing integer milliseconds keep working unchanged. `nonRetryable` moves into the policy, so every holder of it — `Http.Request` included — ends the loop on a listed code. A new `retryAfter` is CEL over the failure just caught (`error`): a duration it yields replaces the computed backoff, capped by `maxDelay`, and null keeps it. `telo check` warns `NON_RETRYABLE_CODE_NOT_THROWN` for a step's `nonRetryable` code its target cannot throw, types `error.data` in `retryAfter` against the target's declared codes, and refuses a negative delay or a non-positive timeout through the bounds the policy's duration slots declare. The deprecated `delay` string is still read.
