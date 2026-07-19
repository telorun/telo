---
"@telorun/kernel": patch
"@telorun/analyzer": patch
---

Bake `extends`-resolved schemas in the build-time validator warm.

A `base:`-less `extends` child is validated at runtime against
`merge(parent, own)`, but the warm pass compiled only the raw `schema:`. The
validator cache is content-addressed, so those are different keys — every
inheriting kind missed the warm on every boot, recompiling its validator and,
on a read-only image, failing to persist it (`EACCES` writing
`.telo/manifests/__validators/`).

`precompileDefinitionSchemas` now also compiles the inheritance-resolved form,
sharing `effectiveAuthorSchema` with the runtime stamp so the two keys cannot
drift. The raw schema is still baked — it backs definitions that don't inherit
and the `controller.schema` fallback path.

The parent is resolved through the new `AnalysisRegistry.resolverForDefinition`,
scoped to the DECLARING module. `extends` aliases are lexically scoped — a
library writes `extends: Cache.Store` against its own import map and `Self.Host`
against its own name — so a global resolver silently fails on both and bakes the
un-merged schema, reintroducing the miss.
