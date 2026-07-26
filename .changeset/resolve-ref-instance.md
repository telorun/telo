---
"@telorun/sdk": minor
"@telorun/kernel": minor
---

Add `ctx.resolveRef<T>(value, guard, describe, expects?)` on `ResourceContext` —
resolve a `!ref` config field to a live instance. The standalone
`resolveRefInstance(value, ctx, guard, describe, expects?)` remains exported for
callers that hold only a `{ moduleContext }` slice; the method delegates to it,
and `resolveInvocableDispatcher` now resolves through it too, so alias semantics
live in exactly one place.

Failures are coded and name the contract: `ERR_REF_REQUIRED` for an unset slot,
`ERR_REF_UNRESOLVED` for one that is set but does not resolve — e.g.
``Cache.Entry "page": 'store' reference 'Redis.store' did not resolve to a
resource satisfying `std/cache#Store` ``.

Phase 5 injection normally replaces the slot with the live instance (local and
cross-module refs alike), so the common path is the guard short-circuit. A raw
`KindRef` still reaches a controller where injection does not reach the slot — a
kind whose definition yields no field map, or a ref obtained via
`ctx.resolveChildren`. Both are gaps worth closing in the kernel; until they are,
this helper is the single place that handles the fallback.
