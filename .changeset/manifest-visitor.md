---
"@telorun/analyzer": minor
"@telorun/editor": patch
---

Add `visitManifest` — one shared manifest visitor that emits the annotation
sites (`RefSite`, `ScopeBoundary`, `SchemaFromSite`, `CelSite`, plus resource
enter/exit bookends) the analyzer's passes previously each rediscovered with
duplicated scaffolding. `validate-references`, `dependency-graph`, and the CEL
context walk now consume it; behaviour is unchanged (full analyzer + integration
suites pass).

Path-driven sites (ref / scope / schema-from) come from the per-kind field map;
CEL sites are found by scanning the value tree, with the field map supplying the
matched `x-telo-context`. Scope is per-resource: `ScopeBoundary` carries both the
source-enclosure prefixes (for ref candidate scoping) and the enclosed-resource
name set (for dropping boot edges to scoped targets), so no cross-resource
ordering or global state is needed.

Exposes `AnalysisRegistry.visitManifest` as the public host seam, and adds the
editor `buildOverviewGraph` adapter that projects `RefSite` events into
capability-classified edges (Service/Invocable/Runnable/Mount) and "uses" chips
(Provider/Type).
