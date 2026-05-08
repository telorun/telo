---
"@telorun/analyzer": patch
---

Schema validation now substitutes `!cel` / `!literal` tagged sentinels with type-appropriate placeholders, the same way it already does for untagged `${{ }}` strings. Previously a tagged scalar against a typed field (e.g. `instructions: !literal "..."` on `type: string`) emitted a spurious `SCHEMA_VIOLATION` because the parsed sentinel object didn't match the declared type.
