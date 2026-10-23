---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/ide-support": minor
---

A reference is told from an inline declaration by a marker, never by a `name` field: every resolved reference carries `__ref: true`, and any other object with a `kind` at a reference slot is an inline declaration of that kind, checked against its schema. A kind whose configuration has a field called `name` can now be declared inline — `icon: { kind: UiLucide.Icon, name: house }` — where it used to be refused as the removed `{ kind, name }` reference form.

`INVALID_REFERENCE_FORM` keeps its wording and its `!ref <name>` repair: it is reported for `{ kind, name }` when the kind's schema declares no `name` field (an open schema included), and for an author-written `__ref` key. What the per-resource checks would say about such an object, read as a declaration, is not reported a second time. Both are refused in the entry's own modules only. A dependency's `{ kind, name }` — what published artifacts carry — is still read as the reference it means, marked at normalization, so an application pinning such a library boots as before; an author-written `__ref` key in a library is refused when an import loads it (`ERR_INVALID_REFERENCE_FORM`). Whether a kind declares `name` is read through local `$ref`s, `allOf` conjuncts and union branches of its author schema. The analyzer exports the reader (`isResolvedReference`, `isInlineDeclaration`, `resolvedReference`, `declaresNameField`, `RESOLVED_REFERENCE_MARKER`); `ensureKindRef` returns a marked reference.

In `@telorun/sdk`, `KindRef` carries the `__ref` marker, and `resolveRefInstance` and a step's dispatch read a value as a reference only when it is marked or a `!ref` sentinel: a hand-built `{ kind, name }` handed to `ensureKindRef` / `resolveRef` is now an inline declaration of that kind. A controller building a reference in code writes `kindRef(kind, name, alias?)`; `isKindRef` and `refSentinelTarget` answer what a value is. The editor support reads a slot's reference the same way, so a navigation entry's inline `icon: { kind: UiLucide.Icon, name: house }` is no reference to `house`.

The Rust kernel judges reference forms only at reference slots, so a resource whose kind declares a `name` field is no longer refused; it reads a library's `{ kind, name }` as a reference and refuses its `__ref` key, and refuses a bare `targets:` entry written `{ kind, name }` as `ERR_INVALID_REFERENCE_FORM`.

A compile-eval result outside its slot's `enum` is refused in the words every schema refusal uses — `must be one of <count> allowed values; did you mean 'house'?`, or the values themselves when there are 20 or fewer — instead of naming only the slot's type.
