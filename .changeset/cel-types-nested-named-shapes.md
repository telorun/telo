---
"@telorun/analyzer": patch
---

CEL now types the members of a named shape nested in any contract: a `!ref` below an `inputType` or `outputType` property types `inputs`, `steps.<name>.result` and a route's `result` against that shape's fields, so a misspelled field under it is `CEL_UNKNOWN_FIELD` in `telo check` and the editor offers the shape's fields in completion. A shape that refers to itself is expanded once and stays open below the point where it recurs.
