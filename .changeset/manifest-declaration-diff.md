---
"@telorun/analyzer": minor
---

`diffManifests` answers what a second load of a manifest set actually changed:
which resources survive untouched, which have to be rebuilt, which are new and
which are gone. It is the first piece of manifest reconciliation, and it is in
the analyzer rather than the kernel because it is pure data in and data out and
the editor wants the same answer — to show which resources a save would restart,
in a browser, where no kernel runs.

Identity is `nodeIdFor`, so it is module-scoped and two libraries each declaring
a resource named `store` are two entries rather than one. `stale` is every
removal and every change, which is what a host unwinds once it has closed that
set under the resources that hold them; `pending` is every addition and every
change, which is what it then creates.

`declarationSignature` renders one declaration so that two equal declarations
render identically, and normalizes away three things that would otherwise report
a change that is not one. Loader stamps go first, `metadata.sourceLine` above all
— inserting a line shifts it for every resource below, so leaving it in would
mark a whole file changed on any edit and defeat the mechanism. A compiled
expression compares by its source text, since what the author wrote is the
declaration. Anything that is not plain data renders as a constant, because a
host that has injected live instances over its reference slots is holding
manifests that are no longer declarations, and walking one reaches a controller's
cyclic object graph.

That leaves the half a declaration cannot answer: `!cel "variables.port"` reads
the same however the environment moves. Only the host that resolved the
environment knows, so `modulesWithChangedConfig` is an input rather than
something derived, and every resource of such a module is reported changed.

One visible consequence: an inline resource's name is synthesized from its
position (`api_routes_0_handler`), so inserting a route above one renames every
inline below it and those read as a removal plus an addition. That costs a
restart it did not have to cost; it never misses a change.

`canonicalJson` is now shared with the module graph's row identity rather than
duplicated, since both compare the result for equality and two implementations
would eventually disagree about key order.

`previousSignatures` lets a caller supply the previous set's signatures instead
of having them computed. A host that INSTALLS manifests does not keep
declarations — the kernel registers the very objects it loaded, and resolving a
reference writes a live instance into one — so signing that side later renders
the slot opaque and reports a change that never happened.
