# @telorun/ide-support

## 0.4.1

### Patch Changes

- @telorun/analyzer@0.10.1

## 0.4.0

### Minor Changes

- d9df589: Add autocomplete for the `source:` field of `Telo.Import`. Hosts implement a new `IdeEnvironmentAdapter` interface to supply filesystem reads and registry HTTP calls; `buildCompletions` is now async and routes a new `field-value` context to a path/registry/version branch. Completions carry an optional `replaceFromColumn` and `filterText` so hosts can replace the full typed value (paths and `namespace/name@version` ids contain `/` and `@`, which the editor's default word boundary won't cross).

### Patch Changes

- Updated dependencies [65647e0]
  - @telorun/analyzer@0.10.0

## 0.3.0

### Minor Changes

- 5c49834: Loader returns the canonical load result; editor stops re-parsing.

  The analyzer's `Loader` now produces a single `LoadedFile` / `LoadedModule` / `LoadedGraph` that carries text, parsed `yaml.Document` ASTs, manifests, position metadata, and canonical identity together. Hosts consume the same parse — the editor no longer runs a parallel YAML pipeline, the VS Code extension and CLI no longer read positions from non-enumerable manifest metadata, and the kernel uses the same primitive for static analysis and runtime entry loads.

  **Breaking changes** in `@telorun/analyzer`. The deprecated methods are removed in this release rather than kept as shims:

  - `Loader.loadModule(url, opts)` now returns `LoadedModule` (was `ResourceManifest[]`).
  - `Loader.loadModuleGraph` removed — use `loadGraph` + `flattenForAnalyzer`.
  - `Loader.loadManifests` removed — use `loadGraph` + `flattenForAnalyzer`.
  - `Loader.loadModuleForFile` legacy shape removed; the replacement is `loadGraphForFile(url) → { graph, ownerUrl } | null`.
  - `attachPositionIndex` (the non-enumerable-metadata helper) removed; positions live on `LoadedFile.positions` and consumers look them up via `findPositions(graph, …)` from `@telorun/ide-support`.
  - `LoadedGraph.importEdges` is now `Map<string, Map<string, ImportEdge>>` carrying `{targetSource, targetModuleName, targetNamespace}` rather than a bare target URL — `flattenForAnalyzer` reads library identity off the edge directly instead of re-deriving from manifest metadata.

  **New surface**:

  - `parseLoadedFile(source, requestedUrl, text, opts?)` — pure, I/O-free parse primitive shared between the editor's source-view debounce and the loader's `read()` post-processing.
  - `Loader.loadFile(url, opts?)`, `Loader.loadGraph(entry, opts?)`, `Loader.loadGraphForFile(fileUrl)` — new methods returning the canonical types.
  - `flattenForAnalyzer(graph)` and `flattenLoadedModule(mod)` — produce the flat `ResourceManifest[]` `analyze()` consumes (graph-wide vs. single-module).
  - `@telorun/ide-support`: `findPositions(graph, diagnosticData)` returns `{file, positionIndex?, sourceLine?}` and replaces every host's hand-rolled "look up the file owning this diagnostic + its positions" loops.

  **Internal effects**:

  - `@telorun/cli`: migrated `check`, `install`, and `publish` to the new API; `formatAnalysisDiagnostics` takes a `LoadedGraph`.
  - `@telorun/kernel`: the kernel's facade methods (`loadModule`, `loadManifests`) preserve their `ResourceManifest[]` API so module controllers don't need to migrate; internally they project from the new types via `flattenForAnalyzer` / `flattenLoadedModule`.
  - The editor's `ModuleDocument` collapses to `{filePath, loaded: LoadedFile, dirty: boolean}`; the previous parallel `parseModuleDocument` pipeline (`text` / `docs` / `loadedJson` / `parseError` snapshots, in-memory adapter, chained adapter, populate/collect-partial passes, `mergeSubGraph`) is gone. Source-view edits and form edits both flow through `parseLoadedFile`; saves re-parse the just-written text to refresh the load-time snapshot.

### Patch Changes

- 50ae578: Unify diagnostic position resolution so the Telo Editor and the VS Code extension report the same line/column for every analyzer diagnostic.

  Previously, the editor's in-memory YAML pipeline projected manifests via `doc.toJSON()` and never stamped `positionIndex` / `sourceLine` onto `metadata`. With those fallbacks missing, `normalizeDiagnostic` collapsed every analyzer diagnostic to `(0,0)` — every squiggle landed on line 1 of the file, regardless of the actual problem location. The VS Code extension didn't have this issue because it goes through `Loader.loadModuleForFile`, which stamps the metadata as a side effect of reading from disk.

  - `@telorun/analyzer`: extract the position-stamping helpers (`buildPositionIndex`, `documentLineOffsets`, `buildLineOffsets`, plus `buildDocumentPositions` / `attachPositionIndex` composers) out of the private bowels of `manifest-loader.ts` and export them. `Loader` itself now consumes the same exported helpers, so editor frontends that parse YAML in-memory can produce identically-stamped manifests without duplicating the offset / AST-walk logic.
  - `@telorun/ide-support`: `NormalizedDiagnostic` now carries the original `data` field through normalization. Editor UIs (popovers, "at &lt;path&gt;" hints, future CodeAction wiring) can read the analyzer's stamps from a single normalized shape instead of holding a raw `AnalysisDiagnostic` alongside.

- Updated dependencies [07c881a]
- Updated dependencies [5c49834]
- Updated dependencies [50ae578]
  - @telorun/analyzer@0.9.0

## 0.2.7

### Patch Changes

- Updated dependencies [30bcfef]
  - @telorun/analyzer@0.8.1

## 0.2.6

### Patch Changes

- Updated dependencies [88e5cb4]
- Updated dependencies [88e5cb4]
  - @telorun/analyzer@0.8.0

## 0.2.5

### Patch Changes

- Updated dependencies [019c62a]
  - @telorun/analyzer@0.7.0

## 0.2.4

### Patch Changes

- Updated dependencies [40ae3ea]
- Updated dependencies [0335074]
  - @telorun/analyzer@0.6.1

## 0.2.3

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/analyzer@0.6.0

## 0.2.2

### Patch Changes

- Updated dependencies [2e0ad31]
  - @telorun/analyzer@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies [80c3c03]
- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/analyzer@0.4.0

## 0.2.0

### Minor Changes

- c97da42: New package. Editor-host-agnostic IDE support for Telo manifests: `buildCompletions(text, line, character, registry)` for completion providers and `normalizeDiagnostic(diag, ctx)` for converting analyzer diagnostics into a host-ready shape with resolved range, severity, and structured `{ kind: "replace-kind", replacement }` suggestions derived from `data.suggestedKind`. Intended to be consumed by both the VS Code extension and the telo-editor Monaco source tab.

### Patch Changes

- Updated dependencies [e35e2ee]
- Updated dependencies [c97da42]
  - @telorun/analyzer@0.3.0
