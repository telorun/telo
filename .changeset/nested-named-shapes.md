---
"@telorun/analyzer": patch
---

A named shape that names another shape — with `!ref`, `telo://Self/<Type>` or the canonical `telo:<Module>/<Type>` — is now read beneath that reference by `telo check`, at call sites and by every validator, as the kernel already reads it: a literal violating the nested shape (a tool call with no `id` inside a message) is reported where it is written. A nested `!ref` that names nothing is reported once, as `SCHEMA_TYPE_REF_UNRESOLVED` at the shape.
