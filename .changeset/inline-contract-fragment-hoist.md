---
"@telorun/analyzer": patch
---

A recursive fragment reached from an inline contract (`outputType: { kind: Telo.JsonSchema, schema }`, likewise `inputType:` and the other schema-valued keys) is now hoisted into the inline shape's `schema`, the object the kernel compiles. Before, it was hoisted beside `kind`, so `$ref: "telo://manifest#/$defs/TextRecord"` there passed `telo check` and every dispatch failed with `can't resolve reference #/$defs/telo:Message`. An inline declaration at a schema-valued key is now expanded as a document of its own kind.
