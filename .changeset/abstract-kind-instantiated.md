---
"@telorun/analyzer": minor
---

Reject a resource declared with an abstract kind, and stop offering one as
something to create.

`kind: Telo.Invocable` and `kind: Sql.Connection` passed `telo check` and then
failed at boot with "is abstract and cannot be instantiated directly" — the
checker was more permissive than the runtime it predicts, and the config
validation that followed checked the declaration against the abstract's own
schema, reporting nothing about the one thing that was wrong. The new
`ABSTRACT_KIND_INSTANTIATED` error covers both shapes a declaration takes: a
resource document, and an inline `{ kind, …config }` at a reference slot, which
an abstract declaring no `schema:` used to slip past entirely. It names the
implementations in the ALIAS form the author would write — the canonical
`sqlite.Connection` the registry is keyed on is not something anyone can type.

The editor half is the same question from the other side. `userFacingKindsForRef`
— what every "create one here" affordance reads — returned the abstracts in the
accepted set, so `Telo.Invocable` and `Telo.Runnable` were offered at every
step's `invoke:` and every boot target, both extending `Telo.Executable`. The
accepted set keeps them, because substitutability and constructibility are
different questions; only the creation answer drops them. `implementationsOf`
drops them too, so the kernel's own "instantiate a concrete implementation" hint
no longer lists kinds it would refuse.

One reader answers it now (`isInstantiableDefinition`), which the completion /
"did you mean" list already had its own copy of.
