---
"@telorun/analyzer": minor
"@telorun/sdk": minor
---

Type `inputType` / `outputType` on `ResourceDefinition` (they were read through an untyped cast). Add `AnalysisRegistry.refFieldsForResource()`, `capabilityForRef()`, and `inputTypeForKind()`. `refFieldsForResource` returns every `x-telo-ref` field a resource's definition declares — path, arity (`isArray`), accepted constraints, and the capabilities each slot may target — derived purely from the schema field map, so it lists slots even when the manifest leaves them empty. `capabilityForRef` resolves an `x-telo-ref` constraint to the base capability it targets (a user-defined abstract's declared `capability`, not its kind). `inputTypeForKind` resolves a kind's `invoke()` input schema (own `inputType`, falling back to the `extends`-declared abstract's). Together they let editor hosts render reference fields as node ports (drag-to-wire for node-capability targets, inline picker for ambient ones) and edit an edge's invocation `inputs` as a typed form — without hardcoding any resource kind.
