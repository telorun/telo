---
"@telorun/analyzer": minor
---

Added: `x-telo-schema-projection` takes `nested: <entry field>` — an entry carrying a sub-collection of entries of the same shape projects to the closed object that sub-collection projects to, recursively, typed statically and enforced at dispatch. An entry that omits `array` or `nullable` now reads the field's declared `default:`. The annotation is closed: an unknown key, or a `nested` field that is not a collection of the same entries, is `SCHEMA_PROJECTION_INVALID`.
