---
"@telorun/kernel": minor
"@telorun/analyzer": minor
---

An inheriting child's own declared fields are published

A `Telo.Definition` that specializes a concrete kind without `base:` is a pure
additive extension: its whole config forwards to the parent's controller and the
parent instance is returned verbatim. So a field the child declared and the
parent has never heard of was held by the parent controller and published by
nothing — `resources.<child>.<field>` resolved to nothing, with no diagnostic,
leaving concrete inheritance able to widen a schema but never to carry new
meaning.

The publication path now joins those fields into the reading, beside where it
already folds a kind's `status:` contract in — not by rebinding the instance's
`snapshot()`, which is a JS-only trick a second kernel cannot reproduce and which
would forge the `typeof x.snapshot === "function"` liveness signal other code
reads. The field names are derived once and stamped onto the definition at
registration, in the scope that declared the `extends` alias.

Only fields the ancestor does **not** declare are published. A redeclared
inherited field is excluded: narrowing its schema says nothing about publication,
while the parent's `snapshot()` remains the sole authority on what a parent
instance publishes — its normalizations, its deliberate omissions and its
redactions. Two values are withheld even for an own field, since neither is a
reading: a slot declared `x-telo-eval: runtime` (still an unevaluated expression
when the reading is taken) and one holding a live resource instance. The `base:`
form is unchanged.

New error `ERR_RUNTIME_EVAL_WITHOUT_INVOKE`: a kind declaring `x-telo-eval:
runtime` whose resources have no `invoke()` used to fail as `undefined is not an
object (evaluating 'instance.invoke.bind')` — a TypeError raised against the
kernel's own source, naming neither the kind nor the field. Runtime evaluation
expands a call's inputs and `run()` / `provide()` take none, so the annotation
can never take effect; that is now said, with the kind and the annotated path.

New error `EXTENDS_CLOSED_PARENT_ADDS_FIELD`: a merge-form child forwards its
whole config as the parent's, so a parent that closes its schema
(`additionalProperties: false`) cannot accept an added field. That already failed
at boot, phrased against the parent kind at the instance's line; it is now
reported by `telo check` at the child's own property, naming the closed ancestor
and pointing at `base:`.
