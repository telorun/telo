---
"@telorun/analyzer": patch
---

Fixed: a `!cel` value below any document-local `$ref` — a draft-07 `#/definitions/F` as well as `#/$defs/F` — is now typed against the field the reference names. Before, only `#/$defs/<name>` and `#` were followed, so an expression under `#/definitions/…` in an `x-telo-eval` field was evaluated with its result type unchecked.
