---
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

Added: `x-telo-eval` is honoured below a map (`additionalProperties` / `patternProperties`), a list (`items`) and a document-local `$ref`, including a shape that refers to itself — so a kind whose configuration is a recursive collection can let a field at every depth be computed with `!cel`. An `x-telo-eval` written beside a `$ref` applies to that field itself. `telo check` accepts an expression there, types it against the field it sits in, and still reports `CEL_IN_NON_EVAL_FIELD` beside it; the kernel evaluates each occurrence at creation without rewriting the manifest the resource is created from. A computed value that fails a Telo format at creation is reported with the field's JSON Pointer (`/fields/a/selector must be a css-selector: …`).
