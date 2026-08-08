---
"@telorun/kernel": patch
---

Fix a gated boot target (`- ref: !ref X` with a `when:` guard) failing schema validation with `/targets/N/when must be string`.

`when` is declared as a string, but the loader compiles a `!cel` leaf into a CompiledValue before the kernel validates the Application. The strip that restores the pre-CEL view bailed out of any slot annotated `x-telo-ref` — and that annotation sits on the targets ARRAY ITEM, so a bare `!ref Foo` target is accepted — leaving the guard a sentinel object that failed every `anyOf` branch. The bail is now driven by what the value IS rather than by the annotation alone: a reference (it carries a `kind`) and a live instance (not a plain object, or exposing a method) are still handed back untouched, while a step object carrying config beside the ref keeps being walked. Affects both gated shapes, `{ref, when}` and `{invoke, inputs, when}`.
