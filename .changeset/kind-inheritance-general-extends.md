---
"@telorun/kernel": minor
"@telorun/analyzer": minor
"@telorun/sdk": minor
"@telorun/http-client": minor
---

General kind inheritance: a `Telo.Definition` may now `extends` **any** kind —
concrete or abstract — with single inheritance. A child that declares no own
`controllers:`/template body inherits the parent's controller by delegation: the
kernel evaluates the child's new `base:` mapping (CEL over `self`) and returns the
native parent instance verbatim, so the child duck-types as its parent. Capability
is inherited and immutable (`EXTENDS_CAPABILITY_MISMATCH` on a conflicting
restatement); `x-telo-ref` slots accept a target kind and every kind that
transitively extends it (Liskov-substitutable). With `base:`, the child's
author-facing schema narrows to its own; without it, it is `merge(parent, own)`.
`Telo.Abstract` is retained as the non-instantiable base. `EXTENDS_NON_ABSTRACT`
is removed. Both paths run end-to-end: `base:` narrowing and the no-`base:`
additive merge (the child carries the parent's config fields directly). The
analyzer statically validates `base:` against the parent config schema
(`BASE_MISSING_REQUIRED` / `BASE_UNKNOWN_FIELD` / `BASE_SCHEMA_MISMATCH`), and the
field map, `self` typing, and per-instance validation all resolve against the
effective (inheritance-aware) schema. The http-client request controller now
resolves a `client` slot through the live instance so an inherited Client works
inside a scope.
