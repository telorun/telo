---
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

Close the validator-cache warm gaps that made `telo run` recompile — and try to rewrite — schema validators on every boot, producing EACCES noise on a read-only image even after `telo install` had warmed the cache.

- The validator cache key now describes what AJV compiles, with `x-telo-*` annotations stripped before hashing. The analyzer canonicalizes `x-telo-ref.kind` to `<module>.<Kind>` and the warm pass bakes that view, while the kernel's controller registry keeps the authored `Self.<Kind>` — two keys for one validator, so every kind whose schema declares an alias-qualified ref missed on every boot. Data-bearing keywords (`const` / `default` / `enum` / `examples`) and name-keyed maps (`properties`, `$defs`, …) are exempt from the strip, so an annotation-shaped key inside a matched value or a property name survives.
- Contract validators (`inputType` / `outputType`) are warmed from the resolved schema the runtime compiles, through the same resolver (`resolveTypeFieldSchema`, extracted from `ResourceContextImpl`) plus the `x-telo-stream` skip. The warm previously compiled the raw declaration — `{kind: Telo.JsonSchema, schema: …}`, not a JSON Schema — and baked a validator no dispatch would ask for. Resource-level narrowings are warmed too, not only kind-level declarations.
- Named types are registered before the contract warm, from the module graph rather than the flattened view, so a contract written as a `$ref` to one resolves the way it will at runtime. Flatten forwards every module's definitions but only the entry's resource instances, and a named type is a resource instance — a library that declares its shapes once and `$ref`s them (`oauth-client`, `vector-store`) had no type doc in the warm's view at all.
- `AnalysisRegistry.resolveSchemaTypeRefs(manifests)` canonicalizes `telo://Self/<type>` references in a caller's own projection of the manifest set, in each doc's declaring scope. `analyze()` already did this to its internal view; the warm holds a separate projection, where an un-canonicalized `$ref` resolved to nothing while the runtime resolved it fine.
