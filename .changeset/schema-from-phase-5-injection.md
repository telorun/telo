---
"@telorun/analyzer": minor
---

Phase 2 inline normalization and Phase 5 reference injection now follow `x-telo-schema-from` indirections, so refs nested inside a sub-schema (e.g. an encoder at `Server.notFoundHandler.returns[].content[mime].encoder`, declared by anchoring at `HttpDispatch.Outcomes/$defs/Returns`) are extracted and injected the same way as locally-declared refs. Previously such slots were silently skipped — inline `{kind: Octet.Encoder}` survived Phase 2 untouched and Phase 5 produced "Encoder ref … is not a live Invocable" 500s at request time. Only static absolute schema-from paths with a dotted alias anchor (the kind owner's import scope) are expanded; relative anchors keep their existing per-resource validation path and remain unchanged.

- `@telorun/analyzer`: `DefinitionRegistry.expandedFieldMapForResource` resolves schema-from anchors through `aliasesByModule` and merges nested ref/scope entries into the iterated field map; `AnalysisRegistry.iterateFieldEntries` and `normalizeInlineResources` consume the expanded map. `normalizeInlineResources` now accepts an optional `aliasesByModule` parameter.
- Releases also fix `scripts/publish-packages.mjs`: a single failing manifest push no longer aborts the loop, so every changed module in a release gets a push attempt before the script exits non-zero.
