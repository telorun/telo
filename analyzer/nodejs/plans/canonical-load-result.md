# Plan — Loader returns the canonical load result; editor stops re-parsing

Scope: collapse the editor's parallel YAML parsing pipeline into the analyzer's `Loader`. After this change every consumer (telo-editor, vscode extension, CLI, future hosts) gets manifests, raw text, parsed `yaml.Document` ASTs, position metadata, and a single canonical identity from one call. The editor's `parseModuleDocument`, `populateModuleDocument`, `collectPartialDocuments`, in-memory adapter, and chained adapter all go away.

Out of scope: changes to controller execution, kernel boot sequence, schema validation rules, the `analyze()` pass itself, or the `yaml` library version. CEL precompilation stays an opt-in `LoadOptions.compile` flag.

## 1. Why

Today two layers parse the same YAML files with two different identity systems, and stay in sync by ad-hoc bookkeeping that keeps producing bugs:

- **Two parsers.** `Loader.loadModule` parses via `yaml.parseAllDocuments` and projects to `ResourceManifest[]` ([analyzer/manifest-loader.ts:78](../src/manifest-loader.ts#L78)). Independently, the editor's `parseModuleDocument` parses the same text again to retain the `yaml.Document` AST for editing ([apps/telo-editor/src/yaml-document.ts:11](../../../apps/telo-editor/src/yaml-document.ts#L11)). On every workspace load both run on every file. On every source-view debounce the editor reparses; the analyzer never sees that result and reparses again on the next analyze pass.
- **Two identities.** The analyzer keys on the source adapter's resolved URL (registry refs become `https://…/telo.yaml`); `metadata.source` carries the resolved form. The editor's workspace map (`subGraph` keys, `documents` map keys, `modules` map keys) uses the user-facing input URL (registry ref `std/javascript@0.3.0` is kept verbatim). `collectPartialDocuments` compares the two, misclassifies every imported library's entry resources as "partials," and tries to re-fetch them through `chainedAdapter` which has no `HttpSource` — producing the "Failed to read … for ModuleDocument" console noise the user reported.
- **Two adapters.** The analyzer holds its own source chain (registry + http + local). The editor builds a parallel `chainedAdapter` ([loader.ts:184](../../../apps/telo-editor/src/loader.ts#L184)) plus an `inMemoryAdapter` that exists solely to feed the analyzer the editor's already-loaded text on the second parse pass.
- **B1 (just merged) only narrowed the gap.** It made `positionIndex`/`sourceLine` stamping a shared helper so both parsers produce identical position metadata. The right answer is one parser, not synchronized clones.

Every recurring bug in this area — URL-mismatch in `collectPartialDocuments`, missing positions in editor diagnostics, duplicate fetch noise, `chainedAdapter`'s missing `HttpSource`, `inMemoryAdapter`'s reach-around to feed the analyzer — is a symptom of the same fork. Closing it lets the analyzer be the canonical "YAML file → load result" primitive it already nearly is.

## 2. The new shape

All new types live in [analyzer/nodejs/src/loaded-types.ts](../src/loaded-types.ts) (new file). They are pure data — no methods, no class wrappers — so the editor can wrap them freely without import cycles.

**Browser-safety convention** (not enforced by the build). `loaded-types.ts` and `parse-loaded-file.ts` are leaf modules and import only from `yaml`, `@telorun/templating`, `@telorun/sdk`, the CEL-environment helpers, and the position-metadata helpers — never `manifest-loader.ts` or `sources/*`. The current sources (`HttpSource`, `RegistrySource`) happen to be browser-safe themselves (only `fetch` and `URL`), so a future `LocalFileSource` from `@telorun/kernel` is the actual Node-only piece. We did not split `index.ts` into separate browser/Node barrels: the cost (two entry points, two `package.json` `exports` conditions, build-system plumbing) is more than the value at this stage. If the editor ever needs to import only the leaf modules — e.g. for a worker bundle that must not pull in `Loader` — promote the convention to two entry points then.

### 2.1 `LoadedFile`

One physical file's parsed result. Returned for the owner manifest, for each `include:` partial, and for each external import target.

```ts
export interface LoadedFile {
  /** Canonical identity. Always the URL the source adapter's read() returned —
   *  HTTPS for http/registry, an absolute path for local. Every map key, every
   *  cross-reference, every editor-side cache uses this exact string. */
  source: string;
  /** The URL the caller supplied (e.g. registry ref `std/javascript@0.3.0`).
   *  Differs from `source` only for adapter-resolved URLs; surfaced so editor
   *  UI can display "what the user wrote" vs "what we fetched" when relevant. */
  requestedUrl: string;
  /** Raw text exactly as `read()` returned it. The editor's source-view
   *  initial text comes from here — no second disk read. */
  text: string;
  /** Per-document parsed AST, in source order. The analyzer treats these as
   *  read-only; whether *callers* may mutate is governed by the structural
   *  `mutability` marker below — see §4.3 for editor-owned semantics. */
  documents: yaml.Document[];
  /** Per-document JSON projection (`doc.toJSON()`). Aligned to `documents`.
   *  Empty docs and root-null docs become `null`. */
  manifests: Array<ResourceManifest | null>;
  /** Per-document `{sourceLine, positionIndex}`. Aligned to `documents`.
   *  Replaces the non-enumerable `metadata.positionIndex` smuggling — callers
   *  read it from the load result, not from manifest metadata. */
  positions: DocumentPosition[];
  /** Document-level parse errors aggregated from `yaml.Document.errors`.
   *  Empty when parsing succeeded for every doc in the file. */
  parseErrors: ParseError[];
  /** Structural marker for who may mutate `documents`. `'shared'` means the
   *  Documents are owned by `Loader.moduleCache` (or another caller's
   *  long-lived store) and MUST NOT be mutated — `Loader.loadModule`,
   *  `Loader.loadGraph`, and any cache hand-out always returns `'shared'`.
   *  `'owned'` means the caller has its own copy and may mutate freely —
   *  `parseLoadedFile` always returns `'owned'`. Mutating helpers
   *  (`applyEdit`, `serializeModuleDocument` callers that intend to edit)
   *  assert `mutability === 'owned'` at runtime — a fast-fail guard against
   *  the "future caller leaks a cached Document into an edit path" bug
   *  class, since the contract is now checkable, not aspirational. */
  readonly mutability: "shared" | "owned";
}

export interface ParseError {
  documentIndex: number;
  message: string;
  /** Line/character of the failure, when the yaml parser provided one. */
  range?: Range;
}
```

### 2.2 `LoadedModule`

An owner file plus the partial files it includes. The unit `Loader.loadModule` returns.

```ts
export interface LoadedModule {
  owner: LoadedFile;
  /** Each `include:` target as its own LoadedFile. Empty when no `include:`.
   *  Order matches the `include:` list (after glob expansion), preserved so
   *  diagnostics keyed on partial-load order stay stable. */
  partials: LoadedFile[];
}
```

### 2.3 `LoadedGraph`

An entry plus every transitively-imported library. Returned by `Loader.loadGraph` (replaces `loadModuleGraph` and `loadManifests`).

```ts
export interface LoadedGraph {
  /** Canonical entry source — equals `entry.owner.source`. */
  rootSource: string;
  entry: LoadedModule;
  /** Map keyed by `LoadedFile.source` (canonical resolved URL). Includes
   *  entry, partials, and every transitively reachable Telo.Import target +
   *  its partials. Lookup is identity-safe because the key is always the
   *  same form `metadata.source` carries. */
  modules: Map<string, LoadedModule>;
  /** Per-Telo.Import resolution. Keyed by the resolved URL of the file the
   *  Telo.Import was declared in, then by the import's PascalCase alias.
   *  Value is the resolved URL of the target — i.e. another key into
   *  `modules`. Replaces the editor's `parsed.imports[].resolvedPath`. */
  importEdges: Map<string, Map<string, string>>;
  /** Surface-level errors that did not abort the graph load (e.g. an import
   *  whose target failed to fetch). Same routing semantics as today's
   *  `onError` callback, captured in the result instead. */
  errors: GraphLoadError[];
}
```

### 2.4 `parseLoadedFile` — the pure primitive

The split that lets the editor reuse the analyzer's parse without going through the source-adapter chain. Used by `Loader` after `read()`, and called directly by the editor on every source-view debounce.

```ts
/** Pure: text in, structured load result out. No I/O, no caches. */
export function parseLoadedFile(
  source: string,
  requestedUrl: string,
  text: string,
  options?: ParseOptions,
): LoadedFile;

export interface ParseOptions {
  /** When true, runs `precompileDoc` per document and stamps compiled CEL
   *  on the manifests — same flag `LoadOptions.compile` carries today. */
  compile?: boolean;
  /** CEL environment for precompile. Defaults to `buildCelEnvironment()`. */
  celEnv?: Environment;
}
```

`Loader.loadFile(url)` becomes one line: `read(url)` → `parseLoadedFile(source, url, text, options)`. `Loader.loadModule(url)` is `loadFile(url)` plus the `include:` expansion that fans out into more `loadFile` calls. `Loader.loadGraph(entry)` is the `loadModule` plus a Telo.Import BFS, capturing edges as it goes.

`include:` glob expansion stays inside `Loader.loadModule` — it lives in `Loader.resolveIncludes` today, delegating to `ManifestSource.expandGlob`, and continues to do so. `parseLoadedFile` is deliberately I/O-free: it never resolves `include:`, never calls `expandGlob`, never touches the source chain. The fanout is the loader's job; the parse primitive only ever sees one already-fetched text blob.

### 2.5 Position metadata moves out of `metadata`

Today `positionIndex` is a non-enumerable property on each manifest's `metadata` object — invisible to spread/serialize, smuggled across boundaries by `attachPositionIndex`. With LoadedFile, callers read `loadedFile.positions[i]` instead. The non-enumerable hack in `manifest-loader.ts` and the matching `cloneManifestArray` carve-out for it both go away.

Migration affects only the consumers that read `metadata.positionIndex`/`metadata.sourceLine` today — the ide-support's `normalizeDiagnostic` ctx, the vscode extension's per-diagnostic lookup, and the editor's analyze-workspace lookup. Each switches to looking up the owning `LoadedFile` by `metadata.source` and reading `loadedFile.positions[docIndex]`.

## 3. Loader API surface

Replace today's three methods with three new ones. The legacy methods are removed in this release rather than kept as shims — the analyzer ships a major version bump and every in-tree consumer (kernel, cli, vscode extension, editor) migrates as part of the same change.

| Today                                        | New                                              |
| -------------------------------------------- | ------------------------------------------------ |
| `loadModule(url, opts) → ResourceManifest[]` | `loadModule(url, opts) → LoadedModule`           |
| `loadModuleGraph(entry, onError) → Map<...>` | `loadGraph(entry, opts) → LoadedGraph` (removed) |
| `loadManifests(entry) → ResourceManifest[]`  | derived view: `flattenForAnalyzer(graph)` helper |
| `loadModuleForFile(url) → {ownerUrl, …}`     | `loadGraphForFile(url) → { graph, ownerUrl }`    |

The `analyze()` pass keeps its current `(manifests, options, registry)` signature — it doesn't need to know about LoadedFile. A helper `flattenForAnalyzer(graph: LoadedGraph): ResourceManifest[]` produces the flat manifest list `analyze()` consumes today, doing the cross-module enrichment that the editor's `analyzeWorkspace` does inline AND the import-identity stamping that `Loader.loadManifests` does inline today ([analyzer/manifest-loader.ts:421-429](../src/manifest-loader.ts#L421-L429)).

Specifically, for every `Telo.Import` manifest in the graph, flattenForAnalyzer must stamp `metadata.resolvedModuleName` and `metadata.resolvedNamespace` by looking up the import's target via `graph.importEdges`, finding the target `LoadedModule`, and reading the `Telo.Library` doc's `metadata.name` / `metadata.namespace`. Without this stamping the analyzer's alias resolver ([analyzer.ts:466-478](../src/analyzer.ts#L466-L478)) and `validate-extends` ([validate-extends.ts:50](../src/validate-extends.ts#L50)) fall back to path-derived identity and produce spurious `EXTENDS_MALFORMED` / `EXTENDS_UNKNOWN_TARGET` diagnostics. flattenForAnalyzer is the only place this stamping happens after migration — both the editor's manual stamping in `analyzeWorkspace` and the analyzer's inline stamping in `loadManifests` are removed.

`moduleCache` keeps existing semantics, including the existing **compile-flag-aware key**: today the cache is keyed by `` `${options?.compile ? "compiled" : "raw"}:${source}` `` so a kernel call (`compile: true`) and an analyzer/editor call (`compile: false`) on the same file get distinct entries. The new cache preserves that exact dual key, only swapping the value type from `ResourceManifest[]` to `LoadedFile`. Without this, a non-compile load served from cache to a compile caller would hand back manifests with no precompiled CEL — or vice versa — silently producing the wrong runtime behaviour. The plan's earlier claim that the key is "same canonical source" is shorthand for "same canonical-source component"; the compile prefix stays.

## 4. Editor migration

### 4.1 `ModuleDocument` becomes a thin wrapper

```ts
export interface ModuleDocument {
  /** Immutable result of the last load/parse. Source of truth for text,
   *  parsed AST, manifests, positions. */
  loaded: LoadedFile;
  /** True when the source view holds uncommitted edits. While dirty,
   *  `loaded` reflects the last committed parse, NOT the buffer in Monaco —
   *  Monaco owns its own model text until the debounce commits a re-parse
   *  via `parseLoadedFile` and replaces `loaded`. */
  dirty: boolean;
}
```

The `loadedJson` / `text` / `docs` / `parseError` fields collapse into `loaded.manifests` / `loaded.text` / `loaded.documents` / `loaded.parseErrors`. The no-op-save guard that used `loadedJson` reads `loaded.manifests` instead.

Mutability: enforced structurally via `LoadedFile.mutability`. `Loader.loadModule` returns `'shared'`; the editor's `register` (for editable workspace files) calls `parseLoadedFile` on `loadedModule.owner.text` to obtain an `'owned'` copy with its own mutable Document. External-import files use `registerReadOnly`, which keeps the `'shared'` LoadedFile from the loader. `applyEdit` and any other mutator calls `assertOwned(loaded)` before touching `loaded.documents`, so a future call site that accidentally hands a registry-imported file into an edit path fails loudly at the boundary instead of silently corrupting the analyzer's cache.

### 4.2 `loadWorkspace` rewritten

Phases collapse from "Phase 0 (per-file populate) + Phase 1 (per-file load) + Phase 2a (per-import sub-graph + populate + collect-partials) + Phase 2b (resolve edges)" to:

```
1. scanWorkspace → list of owner file paths.
2. For each owner: const lm = await loader.loadModule(filePath, { freshAst: true });
                   register(lm.owner); for (p of lm.partials) register(p);
3. For each owner's parsed Telo.Imports (resolved by the loader, not by the editor):
     if (importKind !== 'local') {
       const graph = await loader.loadGraph(depUrl);
       for (const lm of graph.modules.values()) {
         if (!documents.has(lm.owner.source)) registerReadOnly(lm.owner);
         for (p of lm.partials) registerReadOnly(p);
       }
       importEdges.merge(graph.importEdges);
     }
4. Build the workspace.modules map by projecting LoadedFile → ParsedManifest
   (cheap: ParsedManifest fields are derivable from loaded.manifests).
```

Gone: `populateModuleDocument`, `collectPartialDocuments`, `createInMemoryManifestSource`, `createChainedManifestSource`, the entire `subgraph.ts` "subgraph merge" function, and the URL-form bookkeeping. The `chainedAdapter` is gone too — the analyzer's source chain (which already supports HTTP/registry) is the only chain.

`registerReadOnly` is the variant for files the editor can't edit (registry/HTTP loads): it stores the LoadedFile directly without re-parsing for a fresh AST. `register` for editable files calls `parseLoadedFile` on `lm.owner.text` so the editor owns its own mutable Document.

**`ParsedImport.resolvedPath` survives unchanged.** It continues to mean what it means today — the canonical resolved URL of the import target, used as a key into `workspace.modules`. The new pipeline populates it from `LoadedGraph.importEdges` (the canonical source of truth post-migration) instead of from `subgraph.ts:mergeSubGraph`. Every existing consumer keeps working without changes:

- [model.ts:69](../../../apps/telo-editor/src/model.ts#L69) (type definition) — unchanged.
- [crud.ts:187,202,216-219](../../../apps/telo-editor/src/loader/crud.ts) (workspace mutation helpers) — unchanged.
- [queries.ts:6-7](../../../apps/telo-editor/src/loader/queries.ts) (graph traversal) — unchanged.
- [analysis.ts:166-168](../../../apps/telo-editor/src/analysis.ts#L166-L168) (cross-module identity enrichment) — replaced by flattenForAnalyzer's stamping (see §3 above), but the field stays for the other readers.
- [ast-ops.ts:59-96](../../../apps/telo-editor/src/loader/ast-ops.ts#L59-L96) (`rebuildManifestFromDocuments` preserves `resolvedPath` across re-projection) — unchanged.
- [InventoryView.tsx:243](../../../apps/telo-editor/src/components/views/inventory/InventoryView.tsx#L243) (display) — unchanged.
- [loader.test.ts:205-256](../../../apps/telo-editor/src/loader.test.ts#L205-L256) (tests pin preservation across rebuilds) — unchanged.

`importEdges` is the new internal-to-loader representation of the same fact; `resolvedPath` is the projection consumed by editor UI. The two stay in sync because `resolvedPath` is populated *from* `importEdges` at projection time. We do not rewrite all UI sites to consume `importEdges` directly — that would be churn for no behaviour change.

### 4.3 Source-view edits

Today: Monaco onChange → debounce → `parseModuleDocument(filePath, text)` → mutate workspace.documents → trigger analyze.

New: Monaco onChange → debounce → `parseLoadedFile(source, source, text)` → replace `documents.get(source)!.loaded` with the new LoadedFile, set `dirty=true` until persist. The analyzer call uses the new manifests + positions on the next pass — no separate reparse.

### 4.4 `analyzeWorkspace` simplifies

`emitDocsFor` no longer projects via `toAnalysisManifest(d)` and stamps `source/sourceLine/positionIndex` by hand — it reads `loaded.manifests[i]` and `loaded.positions[i]` directly. Most of the file becomes `for each module → for each manifest → push(stamp module identity)`.

The diagnostic-routing loop loses its `manifestsByResource` lookup for positions; it reads `loaded.positions[docIndex]` from the file the diagnostic targets. The `manifestsByResource` map can stay for whatever else needs name-keyed manifest lookup, or be removed entirely if no other consumer remains.

### 4.5 Edits-after-load (apply, diff, save)

`apply-edit.ts` and `diff-fields.ts` continue to operate on `loaded.documents` — same `yaml.Document[]` shape, same mutation semantics. `serializeModuleDocument(loaded.documents)` continues to work unchanged. After a save, the editor calls `parseLoadedFile` on the just-written text to re-establish a clean LoadedFile (and clear `dirty`).

## 5. Kernel migration

The kernel is a first-class consumer of `Loader`, not an external one. It calls `loader.loadManifests(sourceUrl)` ([kernel/nodejs/src/kernel.ts:221](../../../kernel/nodejs/src/kernel.ts#L221)) for entry-point loads and `loader.loadModule(sourceUrl, { compile: true })` ([kernel.ts:260](../../../kernel/nodejs/src/kernel.ts#L260)) for compile-mode loads. `import-controller.ts` uses both via the `ResourceContext` bridge. Step 6 cannot delete `loadManifests` / the legacy `loadModule` shape until the kernel is migrated alongside it.

The migration is mechanical and matches the editor/CLI pattern: replace each call site with `loader.loadGraph(...)` (or `loader.loadModule(...)` for the cases that already only consume the entry module) and pass the result through `flattenForAnalyzer` to recover today's `ResourceManifest[]`. The kernel does not need positions or AST — only the flat manifests with `resolvedModuleName` / `resolvedNamespace` stamped — so `flattenForAnalyzer` is the entire bridge. The `compile: true` flag flows through unchanged via `LoadOptions`.

Kernel integration tests exercise these call sites end-to-end; they pass once `flattenForAnalyzer` produces the same flat list (with the same import-identity stamping) the kernel sees today.

## 6. VSCode extension and CLI migration

Both hosts share the same shape: load via `Loader`, run `analyze`, format diagnostics with positions resolved from manifest metadata. Both read `metadata.positionIndex` / `metadata.sourceLine` directly today ([ide/vscode/src/extension.ts:217-219](../../../ide/vscode/src/extension.ts#L217-L219), [cli/nodejs/src/logger.ts:84-90](../../../cli/nodejs/src/logger.ts#L84-L90)). Both lose those reads.

```ts
const graph = await loader.loadModuleForFile(filePath);  // now LoadedGraph
const manifests = flattenForAnalyzer(graph);
const diagnostics = analyzer.analyze(manifests, undefined, registry);

for (const d of diagnostics) {
  const positions = findPositions(graph, d.data);  // see §6
  const normalized = normalizeDiagnostic(d, {
    registry,
    positionIndex: positions?.positionIndex,
    sourceLine: positions?.sourceLine,
  });
  // vscode: toVscodeDiagnostic(normalized)
  // cli: format `${displaySource}:${line}:${col}` from normalized.range
}
```

The custom `manifestByKey` map (vscode) and the inline `positionIndex` lookups (cli) both get replaced by the shared `findPositions` helper from `@telorun/ide-support` (§6). The `(m.metadata as any).positionIndex` reads disappear from both hosts at once. Both migrations land in the same step (§7 step 4) so the helper API doesn't churn.

## 7. ide-support adjustments

`DiagnosticContext` keeps its current shape. `normalizeDiagnostic` doesn't change.

A new helper exported from `@telorun/ide-support`:

```ts
export function findPositions(
  graph: LoadedGraph,
  diagnosticData: unknown,
): { positionIndex?: PositionIndex; sourceLine?: number } | undefined;
```

Encapsulates the "look up the LoadedFile that owns this diagnostic, find the doc index for the named resource, return its positions" routing both the editor and vscode extension write inline today.

## 8. Migration order (each step keeps the build green)

1. **Add new types and `parseLoadedFile`** in analyzer. No call-site change yet. New unit tests cover the parse primitive end-to-end (offset arithmetic, partial expansion, error capture).
2. **Add `Loader.loadFile` / new `loadModule` / `loadGraph`** alongside the existing methods. Old methods stay; their bodies change to call the new ones and project down to today's return shape. Existing tests cover the projection.
3. **Migrate editor consumption to the new API, keep the old helpers in place.** New `ModuleDocument` shape, `loadWorkspace` rewritten to call `loader.loadModule` / `loader.loadGraph` and stop calling `populateModuleDocument` / `collectPartialDocuments` / `mergeSubGraph` / the in-memory adapter / the chained adapter. Update `applyEdit` and `diffFields` call sites to read `.loaded.documents`. Update `analyzeWorkspace` to read positions from LoadedFile. Update `reconcileImports` to call `loader.loadGraph` for newly-added imports rather than `mergeSubGraph`. Old helpers (`createInMemoryManifestSource`, `createChainedManifestSource`, `populateModuleDocument`, `collectPartialDocuments`, `mergeSubGraph`) stay in `subgraph.ts` but become dead code with no callers — their tests run but the production codepaths no longer hit them. `resolveDepPath` (also in `subgraph.ts`, re-exported by `loader.ts` and used inside `loadWorkspace` to convert raw import sources to canonical URLs) is *not* dead code: it survives, either staying in `subgraph.ts` until step 5 only to be moved out then, or relocating into the editor's `loader.ts` in this step. Pick one; don't accidentally delete it. Splitting "migrate uses" from "delete" guarantees we can revert step 3 if a subtle reconcile-edge or in-memory-bridge dependency surfaces in dogfood, without losing the safety net.
4. **Migrate the vscode extension and CLI** to consume LoadedGraph + the new ide-support `findPositions`. Both hosts in one PR so the helper API doesn't churn between them.
5. **Migrate the kernel** to call `loader.loadGraph(...)` + `flattenForAnalyzer` in place of `loader.loadManifests(...)` and the legacy `loader.loadModule(...)` shape ([kernel.ts:221](../../../kernel/nodejs/src/kernel.ts#L221), [kernel.ts:260](../../../kernel/nodejs/src/kernel.ts#L260), and the matching `import-controller.ts` paths). Existing kernel integration tests pin behaviour. Lands as its own PR so a kernel regression doesn't get bundled with the editor/vscode/cli migration.
6. **Delete the dead helpers from step 3** (`createInMemoryManifestSource`, `createChainedManifestSource`, `populateModuleDocument`, `collectPartialDocuments`, `mergeSubGraph`) plus their tests, and confirm `resolveDepPath` has landed in its post-migration home. Trivial diff once steps 3, 4, and 5 have soaked.
7. **Delete deprecated analyzer methods** (`loadModuleGraph`, `loadManifests`, `loadModuleForFile` legacy shape, `attachPositionIndex` non-enumerable hack, `cloneManifestArray`'s positionIndex carve-out). Single PR, minor bumps for analyzer + ide-support + kernel. Safe only because step 5 already migrated the kernel off these methods.

Each step is an atomic PR; intermediate states keep the build, the test suite, and all four hosts (editor, vscode, CLI, kernel) working.

## 9. Risks and what stays unchanged

- **CEL precompile flag.** `parseLoadedFile` accepts `compile`; identical semantics to today's `LoadOptions.compile`. The kernel keeps loading with `compile: true`; the analyzer/editor keep `compile: false`.
- **yaml.Document mutability.** Editor-owned files get a fresh parse via `parseLoadedFile` so their AST isn't shared with the analyzer's cache. External-import files are read-only — sharing is safe and saves memory across re-analyzes.
- **moduleCache invalidation.** Same key shape (`` `${compile ? "compiled" : "raw"}:${source}` ``), same text-equality check. No behavioural change for the analyzer's internal callers — see §2.4 for the compile-prefix preservation rationale.
- **`metadata.source` value.** Unchanged: still the resolved URL stamped by `read()`. Only the *redundant* sources of the same data (positionIndex on metadata, editor's parallel parse, two URL forms) are removed.
- **No new abstractions for hypothetical consumers.** Every type and method in this plan is consumed by code that exists today.
