---
"@telorun/lease": minor
"@telorun/sdk": minor
---

`Lease.Critical` learns `op: cancel`: a running **detached** body can be ended
early by invoking the lease with `{ op: cancel, key, holder? }`. The body runs
under a lease-owned cancellation scope, so the cancel trips its cancellation
token — every honoring leaf (a model call, a `Timer.Delay`, a fetch) aborts —
and the lease releases on the body's terminal. The `holder` guard refuses a
stale cancel aimed at a newer occupant of the key, and a body ending because it
was cancelled is treated as an expected terminal, not a detached failure.

SDK: `resolveInvocableDispatcher`'s returned thunk accepts an optional
`InvokeContext` second argument, letting a decorator seed the dispatch's
cancellation scope (backwards compatible — omitted means the ambient context
applies unchanged).
