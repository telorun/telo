---
"@telorun/analyzer": minor
---

Add `AnalysisRegistry.outputTypeForKind(kind)`, mirroring `inputTypeForKind`: resolves a kind's `outputType` (own definition, then the `extends`-declared abstract) to its JSON Schema for editor hosts that render a typed output signature. Inline and raw-schema forms resolve; a bare named type reference is left unresolved.
