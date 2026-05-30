# Manifest Visitor — Implementation Plan

> **Status: implemented.** `visitManifest` lives in
> [analyzer/nodejs/src/manifest-visitor.ts](../src/manifest-visitor.ts) and is
> consumed by `validate-references`, `dependency-graph`, the analyzer's CEL
> walk, and the editor's `buildOverviewGraph`. This document describes the
> shipped design.

## Problem

The analyzer runs several validations and analyses over a manifest, each
implemented as its own walk over the resource tree:

- [validate-references.ts](../src/validate-references.ts) — every `x-telo-ref` site
  type-checked against its declared constraint.
- [validate-cel-context.ts](../src/validate-cel-context.ts) — every `${{...}}`
  expression compiled and type-checked against the CEL scope available at its path.
- [dependency-graph.ts](../src/dependency-graph.ts) — refs aggregated into adjacency
  for boot-order topological sort (skipping scope-crossing refs).
- [resolve-ref-sentinels.ts](../src/resolve-ref-sentinels.ts) — load-time
  replacement of `!ref name` sentinels with concrete `{kind, name}` references.
- Schema-from expansion (`x-telo-schema-from`) — slots that derive their schema
  from a referenced resource's `$defs`, threaded through ref/CEL validation.
- Scope visibility (`x-telo-scope`) — refs inside a scope boundary resolve against
  enclosed resources, not the outer module.

Each walk reimplemented the same scaffolding: fetch the resource's per-kind field
map, collect its scope fields, iterate the ref/schema-from entries resolving each
against the resource value, and — for CEL — scan the value tree for compiled
expressions. The precomputed maps differ by annotation type, but the iteration
scaffolding and the lessons each consumer needed to learn (`oneOf` / `anyOf`
walking, nested array descent, `x-telo-schema-from` expansion, scope handling)
were duplicated everywhere. A fifth consumer is incoming: the editor's overview
graph needs ref sites (see
[apps/telo-editor/plans/resource-graph-canvas.md](../../../apps/telo-editor/plans/resource-graph-canvas.md),
which lists this plan as a prerequisite).

## Solution

One manifest visitor in [analyzer/nodejs/src/manifest-visitor.ts](../src/manifest-visitor.ts):

```
visitManifest(resources, registry, visitor, options)
```

It runs **one per-resource pass** that drives **two discovery mechanics** behind
one optional-handler visitor API. The unification is at the *scaffolding* and
*consumer-interface* layers; the two mechanics are not merged into a single tree
descent, because they fundamentally differ:

- **Path-driven** (against the per-kind field map): ref / scope / schema-from
  sites. This is map iteration resolved against the resource value via
  `resolveFieldEntries`, not a node-by-node tree descent. The existing
  `ReferenceFieldMap` already unifies all three annotation types into one
  per-kind index, so no rename was needed — it *is* the site map. Emits
  `RefSite`, `ScopeBoundary`, `SchemaFromSite`.
- **Value-tree-driven** (`walkCelExpressions` over the resource value): compiled
  `${{...}}` / `!cel` nodes. CEL can sit in **any** string field, including
  fields the field map never lists, so its discovery is inherently not
  path-driven. The field map's only role for CEL is to supply the matched
  `x-telo-context` schema at the enclosing path (via `extractContextsFromSchema`
  + `pathMatchesScope`); it does not enumerate CEL locations. Emits `CelSite`.
- **Value-tree-driven nested refs** (opt-in via `discoverNestedRefs`): a scan for
  `!ref` sentinels and `{kind, name}` reference objects, surfacing refs the field
  map can't reach because they sit behind a `$ref` it doesn't descend (notably
  `Run.Sequence` `steps[].invoke`). Emitted as `RefSite`s with `nested: true`,
  deduped against the field-map sites by concrete path. The scan stops at every
  `{kind, …}` resource boundary (emitting a named ref but not descending into a
  nested resource's own config), so an inline sub-resource's refs belong to that
  resource, not the enclosing one. Opt-in because these refs are runtime-resolved,
  not boot dependencies — the validators and dependency graph leave it off; only
  consumers that want the full reference picture (the editor overview graph)
  enable it.

Handlers are optional (Babel-style): the walker computes and emits only what the
visitor subscribes to, and skips the work behind absent handlers. Each consumer
calls `visitManifest` with its own single-purpose visitor and its own
`skipKinds` / `expand` options — "one tree descent" is per-call, and what is
removed is the *duplicated scaffolding*, not a globally shared walk.

The event stream is one discriminated set of optional handlers:

- `onRef(RefSite)` — `x-telo-ref` slot. Carries `fieldPath`, `concretePath`
  (matching `buildPositionIndex` keys), the ref `value`, the `entry`
  (refs/isArray/context), and — computed by the walker — `inScope` (source
  enclosure) plus `visibleScopeManifests`. *(path-driven)*
- `onCel(CelSite)` — compiled expression with `path`, `expr`, `engineName`, and
  the raw `contextSchema` / `matchedScope` resolved from the enclosing
  `x-telo-context`. *(value-tree-driven)*
- `onSchemaFrom(SchemaFromSite)` — `x-telo-schema-from` slot with its `entry`.
  *(path-driven, base map)*
- `onScope(ScopeBoundary)` — emitted **once per resource**, before that
  resource's `RefSite`s, carrying `scopePrefixes`, `manifestsByPointer`, and the
  **enclosed-resource name set**. *(path-driven)*
- `onResourceEnter` / `onResourceExit` — bookend events per resource (the enter
  event also carries the resolved `definition`), for per-resource setup/teardown.

**Scope is per-resource, not tree-ordered bookends.** Every consumer's scope
decision is local to the resource being visited, matching the semantics each pass
had before the walker existed — so the walker needs no cross-resource event
ordering and no global enclosed-name union. `ScopeBoundary` exposes both pieces of
information consumers need: `validate-references` reads `RefSite.inScope` /
`visibleScopeManifests` (the **source enclosure** the walker derives from the
scope prefixes) to scope a ref's candidate set; `buildDependencyGraph` reads
`ScopeBoundary.enclosedNames` (**target-name membership**, local to the source
resource) to drop boot edges to scoped targets. Because `onScope` fires before
the same resource's `RefSite`s, a consumer can capture `enclosedNames` and use it
while handling that resource's refs without buffering the whole walk.

**Field map.** The per-kind `ReferenceFieldMap` already records ref, scope, and
schema-from entries in one index; `visitManifest` consumes it via
`registry.getFieldMapForKind` and, with `expand: true`,
`registry.expandedFieldMapForResource` for `x-telo-schema-from` resource-specific
expansion. `SchemaFromSite` events come from the **base** map regardless of
`expand`, since expansion replaces those entries with the nested refs they hide.

**Consumer refactors.** Three annotation-driven walks became visitors and ship
together — extraction correctness is demonstrated by subsumption (the full
analyzer + integration suites pass unchanged):

- `validate-references` — keeps its duplicate-name pre-pass, then runs two
  visitor passes. An `onRef` pass (`expand: true`) checks each ref's
  structure / kind / resolution using `inScope` + `visibleScopeManifests`. A
  second `onSchemaFrom` pass (`expand: false`) preserves the Phase 3b
  schema-from validation that validates each field value against the derived
  sub-schema. Two passes keep the original two-phase diagnostic ordering exact.
- `validate-cel-context` (the analyzer's CEL walk) — an `onCel` handler. The
  walker delivers the matched raw `x-telo-context`; the handler keeps the
  analyzer-internal resolution (step context, kernel-globals merge,
  `x-telo-context-*` annotation resolution, the typed CEL env), because that
  depends on analyzer state the walker is built to stay free of.
- `buildDependencyGraph` — an `onScope` handler captures the source resource's
  `enclosedNames`; an `onRef` handler adds the edge unless the target name is in
  that set. This preserves the current semantics exactly: an edge `A → B` is
  excluded only when `B` is declared inside `A`'s own scope. Public return shape
  (`{order?, cycle?}`) and contract unchanged.

`resolve-ref-sentinels` is **not** subsumed. Sentinel resolution runs at load
time, before per-kind site maps are stable, and the load pipeline is not
restructured here. It remains a separate load-time pass; the visitor operates on
already-resolved manifests. Site map construction is downstream of sentinel
resolution and moving it upstream is its own design problem.

**Host seam.** `AnalysisRegistry.visitManifest(resources, visitor, opts)`
delegates to the underlying walker bound to the registry's definitions and
aliases — the public entry point for hosts (the editor) that must not reach into
the internal `DefinitionRegistry`.

**Editor-side adapter.** `buildOverviewGraph(resources, registry)` in
[apps/telo-editor/src/components/views/topology/overview-graph.ts](../../../apps/telo-editor/src/components/views/topology/overview-graph.ts)
runs `registry.visitManifest` with a `RefSite`-only visitor, classifying each ref
by its target's capability: node capabilities (Service / Invocable / Runnable /
Mount) become `LabeledEdge`s, ambient capabilities (Provider / Type) become
`UsesChip`s. Classification is capability-driven via `registry.resolveDefinition`
— no resource kind is hardcoded. Application↔target edges are constructed
separately from `manifest.targets` by the consuming canvas, because the
Application root isn't a `ResourceManifest` and doesn't ride the visitor's
iteration surface.

**Out of scope.** AJV structural schema validation (not annotation-driven, runs
against whole-resource schemas); cross-resource invariants that aren't per-site
events (cycle detection runs on the adjacency *output*, not inside the walker);
name uniqueness; import resolution.

## Decisions

- **One visitor, two discovery mechanics behind one API — not a single tree
  descent, and not one walker per annotation type.** Path-driven sites
  (ref/scope/schema-from) come from per-kind field-map iteration; CEL comes from
  value-tree scanning. Both ride one per-resource pass and one optional-handler
  visitor, which is what removes the duplicated scaffolding (`oneOf` walking,
  nested-array descent, schema-from expansion, scope tracking) across consumers.
  Framing it as a single node-by-node descent would have been wrong: the
  path-driven mechanic resolves known paths against the value, it does not walk
  the tree. Rejected alternative: parallel primitives per annotation type
  (`walkRefSites`, `walkCelSites`, …) — preserves the duplicated descent in every
  walker; every new annotation gets its own.
- **`ScopeBoundary` is per-resource, carrying enclosed names and source-enclosure
  prefixes.** Both pieces are load-bearing for different consumers and the event
  exposes both, but scoping stays local to the resource being visited — no
  tree-ordered enter/exit and no global enclosed-name union, because no consumer
  needs them (today's dependency-graph filter is already source-local:
  `A → B` drops only when `B` is in `A`'s own scope). `onScope` firing before the
  same resource's `RefSite`s lets the dependency graph capture `enclosedNames`
  and decide per-edge without buffering. Rejected alternatives: (a) tree-ordered
  enter/exit bookends — forces the walker into a genuine ordered descent the
  path-driven mechanic can't cheaply provide, for no consumer benefit; (b) a
  per-site `isScoped` boolean — collapses two distinct filtering criteria
  (source enclosure vs. target-name membership) into one flag that fits neither.
- **`SchemaFromSite` has an assigned consumer.** The walker emits it from the
  base map, and `validate-references` runs a dedicated `onSchemaFrom` pass that
  preserves the schema-from *value* validation (field value vs. derived
  sub-schema). Emitting the event without a consumer would have silently dropped
  that check — subsumption has to carry every behaviour the old walk had.
- **The CEL site seam stops at context *matching*.** `CelSite` carries the raw
  matched `x-telo-context` and its scope; the analyzer consumer keeps the heavy,
  state-dependent resolution (step context, kernel globals,
  `x-telo-context-*`, the typed CEL env). Pulling that into the walker would drag
  analyzer-internal state into a primitive meant to stay transport-neutral.
- **`ReferenceFieldMap` is kept, not renamed to `SiteMap`.** The per-kind index
  already unifies ref / scope / schema-from entries — it is the site map in all
  but name. A sweeping rename across the registry and every pass would be churn
  with no behavioural benefit; the visitor consumes the existing structure.
- **Subsumes `validate-references`, `validate-cel-context`,
  `buildDependencyGraph`.** Three consumers prove the design; one would only
  assert it. Rejected alternative: ship the walker with one consumer and refactor
  the rest later — leaves duplicate walks live and lets the event shape drift
  toward whatever shipped first.
- **Host access via `AnalysisRegistry.visitManifest`, not the internal
  registry.** The editor only holds an `AnalysisRegistry`; exposing a delegate
  (mirroring the existing `iterateFieldEntries`) keeps the internal
  `DefinitionRegistry` bridge inside the analyzer package. Rejected alternative:
  let the editor reach `_context().definitions` — leaks an `@internal` bridge
  into host code.
- **Application→target edges stay editor-side, outside the visitor.** The
  Application root is not a `ResourceManifest`; forcing it through the iteration
  surface would need a synthetic root resource or kind-specific dispatch in the
  walker (which the walker is built to avoid). The consuming canvas loops over
  `manifest.targets` directly.
