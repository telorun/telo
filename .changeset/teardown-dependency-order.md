---
"@telorun/kernel": minor
---

A resource is now torn down before every resource it holds, across an import
boundary as well as inside one context.

The cascade used to tear down every child context before any resource of the
context that owned it. A child context is an imported library, so an application
resource holding `!ref Alias.name` unwound *after* its provider was already gone
— and an inverse that hands a connection back, closes a subscription or
deregisters from a provider ran against a resource that no longer existed. Two
shipped inverses do exactly that: the Postgres journal's wake subscription closes
a listener on a connection it holds, and the durable resumer's inverse is a
closure the journal handed it.

Own resources now unwind first, and the child sweep is a backstop. A child
context that belongs to a resource is already torn down by that resource's own
inverse — an import's `init()` returns `child.teardownResources()`, and so does a
template's — so it unwinds at its owner's position rather than ahead of
everything. The sweep still runs afterwards, because `teardownResources` is
idempotent and two shapes reach it unclaimed: a `lifecycle: shared` library,
which deliberately gives no importer a claim, and an import whose `init()` never
ran to register one. Both directions come out right for the same reason: a
library borrowing a parent instance through `resources:` unwinds before that
instance, because its import initialized after it.

Within a context the order is now reverse-topological over the reference edges
captured at `create()` time, with reverse insertion as the tiebreak, rather than
reverse insertion alone. For an edge that Phase-5 injection resolves the two
agree, since the init loop defers a resource whose refs are unresolved and so
cannot insert a consumer before its provider; what the edges add is the same
guarantee for an edge that never passes through injection, such as a controller
resolving a sibling by name inside `init()`. A cycle falls back to the tiebreak
order rather than raising, because teardown must always run to completion.

`teardownPriority` is unchanged and stays a hard tier, because it states an edge
nothing captured: a log sink is reached through `ctx.log` rather than a ref slot,
so no walk of the manifest can find the resources that will log on the way down.
On a context it now orders the backstop sweep, which is library-against-library.
