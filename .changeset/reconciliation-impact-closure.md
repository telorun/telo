---
"@telorun/kernel": minor
---

`impactClosure` answers the second question the create-time reference edges can
be asked: if these resources are about to become invalid, who else is holding
one and therefore becomes invalid too. It is the reverse of the walk teardown
ordering already does, so both now live in `resource-edges.ts` and read the same
`Map<consumer, provider names>` without knowing what a resource is.

A holder has to go with what it holds because it is holding the instance itself:
Phase-5 injection wrote a live object into its reference slot, and rebuilding the
target leaves it pointing at an object nothing will call again. So replacing one
resource restarts everything above it — a cost worth stating rather than a defect
to fix, since it means editing a connection's declaration restarts what uses it.

`EvaluationContext.impactedBy(names)` is the per-context form. A cross-module
reference projects onto the local `Telo.Import`, so a change inside an imported
library reaches a context as its import being impacted and the library goes down
with that import's own inverse — which is why this answers for one context rather
than walking the tree.

It is exact over the DECLARED edges and only those. A controller that resolves a
sibling by name instead of through a reference slot — `Config.Variables`,
`Config.Secrets` and the MCP tool bundle all do — has a real dependency no walk
of the manifest can see, so a reconciler built on this alone would leave such a
holder running against a rebuilt target. That gap is named in the function's own
documentation rather than left to be discovered, and closing it is a change to
what a module may do rather than to this function.

`Kernel.reconcile()` is its consumer.
