---
"@telorun/analyzer": minor
---

Validate `Run.Sequence`-style step `invoke` references. The reference field map
deliberately does not descend into step `invoke` slots (they sit behind the
shared step `$ref`, and descending would make Phase 5 inject live instances
there), so these slots escaped `validateReferences` entirely — a step
`invoke: !ref <name>` that named a missing instance, or a *kind* instead of an
exported instance (`invoke: !ref Stream.Of`), passed `telo check` and only
failed at runtime with `ERR_RESOURCE_NOT_FOUND`. A new pass covers exactly those
slots in two dimensions: after sentinel resolution, an invoke value still a
`!ref` sentinel is reported as `UNRESOLVED_REFERENCE` (missing instance /
kind-instead-of-instance), and a resolved instance whose capability structurally
has no invoke/run method (`Telo.Provider` / `Telo.Mount` / `Telo.Type` /
`Telo.Template`) is reported as `REFERENCE_KIND_MISMATCH` — the static mirror of
the runtime `ERR_RESOURCE_NOT_INVOKABLE` (`Telo.Service` is excluded, since some
services are invocable). Generic and topology-driven — it walks steps via the
same `x-telo-step-context` / `x-telo-topology-role` annotations as the
step-context builder (through a shared step-walker), so nested branches
(then/else/do/catch/cases) are covered and no resource kind is hardcoded, and it
applies the same cross-module partial-analysis guard as `validateReferences`.
