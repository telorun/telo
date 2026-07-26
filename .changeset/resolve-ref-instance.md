---
"@telorun/sdk": minor
---

Add `resolveRefInstance<T>(value, ctx, guard, describe)` — resolve a `!ref` config
field to a live instance.

A reference is normally replaced with the live instance during Phase 5 injection,
so a controller can just use the field. That does not happen for a ref crossing an
import boundary: it arrives as the raw `{ name, alias }` shape and must be routed
through the import's exported scope, not a bare local lookup. Every controller
with a provider-shaped dependency pays that cost, and each had reimplemented it.
One implementation means one place to simplify when the kernel closes the gap, and
one error-message shape for authors.
