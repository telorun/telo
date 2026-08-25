---
"@telorun/analyzer": minor
---

A schema slot may now union a **value branch with a reference branch** — a
declared column's `type:`, holding either a storage class from a closed
vocabulary or a `!ref` to a named shape.

A bare string at any slot carrying an `x-telo-ref` was `INVALID_REFERENCE_FORM`,
so the value half of such a union was rejected outright. Where the reference
constraint is a *branch* rather than the node's own annotation, a **scalar** is
now read as a value and left to that branch — including a misspelled one, which
AJV reports as an unknown value rather than as a broken reference, since telling
an author to write `!ref txt` converts a typo into a reference. An **object** is
still checked for the removed `{kind, name}` form unless a branch describes that
shape.

Both reference passes apply the narrowing: `validateReferenceForms` and
`validateReferences`, the second because an object-shaped value branch would
otherwise reach the structural check and be reported as a reference missing
`kind` and `name`.

The narrowing is what keeps the rule intact everywhere it still applies: a
node-level `x-telo-ref` with branches beneath it (an Application `targets` entry)
uses those branches to describe the post-resolution shapes a *reference* takes,
and a bare string there is still the removed string-reference spelling.

`RefSlot` gains `valueBranches`, carried onto the field-map entry. Both passes
narrow through one `satisfiesValueBranch`, and a branch AJV cannot COMPILE is not
a branch a value satisfies — `validateWithRefs` swallows a compile failure by
design, so reading that as "no issues, therefore a value" would switch the
reference-form rule off for the slot silently.
