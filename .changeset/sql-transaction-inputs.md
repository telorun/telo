---
"@telorun/sql": patch
---

`Sql.Transaction` expands its declared `inputs:` map with the caller's
invocation input bound under the `inputs` CEL name — the same variable a
`Run.Sequence` step's inputs read — instead of spreading the raw input object
as bare top-level names nothing could statically type.
