---
"@telorun/kernel": minor
---

`EvaluationContext.unwindResources(names)` tears down some of a context's
resources and leaves the rest running — reconciliation's half of teardown, and
the last kernel primitive a reconciler needs before the load path itself is
split.

Ordering is the same `teardownOrder` a full teardown uses, restricted to the
selection, so a consumer still unwinds before what it holds. What makes that true
of the resources left standing is the selection being closed under holders, which
is `impactedBy`'s answer: none of the survivors holds anything in the set.

The context keeps its state — it is neither draining nor torn down — and no child
context is swept, because a child belonging to an unwound import goes down with
that import's own inverse exactly as it does at teardown. A name with no live
instance is skipped rather than reported: a resource that failed to initialize
has nothing to unwind, and a host asking for it is asking about a declaration.

`teardownResources` is now this same loop over every resource, plus the child
sweep and the state transitions, so the two cannot drift about what unwinding one
resource means.
