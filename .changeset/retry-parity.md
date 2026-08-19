---
"@telorun/analyzer": minor
"@telorun/sdk": minor
---

Retry parity: a step's retry policy gains `nonRetryable` (error codes that end the loop immediately) and a step gains a per-attempt `timeout:`.

The leaf's built-in exclusions are the ones decidable without judgement — cancellation, and the kernel's verdicts on the shape of the call. Whether a DOMAIN failure is worth re-attempting is not decidable there at all, so without `nonRetryable` every terminal domain failure was retried to exhaustion. It sits as a sibling of the shared `RetryPolicy` fragment rather than inside it (the way `Http.Request.retry` adds `honorRetryAfter`), because it matches an error CODE while an HTTP retry classifies on a response STATUS.

`timeout:` bounds ONE attempt, matching Temporal's start-to-close, and is enforced by cancellation: the step mints a scope linked to the caller's token and threads it into the dispatch, so a target that honours cancellation stops rather than running on unobserved. On elapse the step fails `ERR_STEP_TIMEOUT` — a code of its own rather than a cancellation, since the two want opposite follow-ups and `catch:` can only tell them apart by code.
