---
"@telorun/analyzer": minor
---

A kind that inherits the `Telo.Type` capability only through `extends: Telo.JsonSchema`, declaring no `capability:` of its own, is now a named shape everywhere a `Telo.JsonSchema` is: a `!ref` to its resources types an `inputType` / `outputType`, an `x-telo-value-schema-from` location and an `x-telo-context-ref-from` path, and canonical type ids are stamped beside references to it. A slot requiring the subtype still refuses a plain `Telo.JsonSchema`.
