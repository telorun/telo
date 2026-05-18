---
"@telorun/analyzer": patch
---

Reference and schema diagnostics now resolve to the correct line in the editor. Two bugs were stacking to make `x-telo-ref` errors land on the resource's top line — or, for inline-extracted children, on the wrong document entirely:

- `validateReferences` and the schema-from validator stored the field-map path (with `[]` wildcards, e.g. `routes[].handler`) in `data.path`, but `buildPositionIndex` keys on concrete indices (`routes[0].handler`). The lookup always missed and the diagnostic fell back to the resource's first line. `resolveFieldValues` now also yields the concrete dotted path for each value (new `resolveFieldEntries` API; old function kept as a value-only wrapper), and every ref / schema-from diagnostic emits that concrete path.
- Synthetic manifests produced by `normalizeInlineResources` (e.g. an inline `{kind: JS.Script, code: ...}` in `routes[0].handler`) had no top-level YAML doc, so `findPositions(graph, …)` could not locate them and routed every diagnostic on a synthetic to the first manifest of the file. `normalizeInlineResources` now stamps each extracted manifest with `metadata.xTeloOrigin = { parentKind, parentName, pathFromParent }`, and a final analyzer pass (`rewriteSyntheticOrigins`) rewrites diagnostics on synthetics by walking the origin chain to the real root and concatenating the parent-relative paths. The IDE's existing lookup-by-resource flow then resolves to the parent doc, and the position-index lookup hits the concrete nested path.

Telo.Definition template bodies (`resources` / `invoke` / `run` / `provide` on a Definition) are still not walked — that case has a separate CEL-context concern (synthetics extracted from a Definition need the parent's `self` / `inputs` typings during CEL validation) and will land in a follow-up.
