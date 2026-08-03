---
"@telorun/analyzer": minor
---

`x-telo-context-from-root` now resolves a `telo#Type` slot to the schema it names, which **tightens an existing check**.

A type field is written as an inline `{ kind, schema }` wrapper, a `!ref` to a named type, or a bare name. Pointing the annotation at one used to type the CEL variable as the *wrapper* — exposing `kind` / `schema` instead of the contract — and forced every such variable to be an object, so a scalar contract could not be expressed at all. It now resolves to the declared schema. A raw JSON Schema still resolves to itself and a plain property map is still used verbatim.

**This can turn a previously-passing manifest into a `telo check` failure.** `Telo.Definition`'s built-in context types a template body's `inputs` with `x-telo-context-from-root: "inputType"` — a type slot. Where that resolved to the wrapper (which declares no `type` / `properties`), `inputs` was typed permissively and any member access passed; it is now typed from the declared contract, so `inputs.<typo>` inside a template definition's `inputs:` / `resources:` body is a `CEL_UNKNOWN_FIELD`. The diagnostic is correct — it catches real typos that used to reach runtime — but it is a new failure on unchanged input, which is why this is a minor rather than a patch. A definition whose `inputType` is undeclared is unaffected (the annotation falls back to an open schema).

This is also what lets `Collection.Fold` type `acc` from its declared `accType`, including a scalar accumulator.
