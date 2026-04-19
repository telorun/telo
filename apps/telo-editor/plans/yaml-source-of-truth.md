# YAML as Source of Truth

## Goal

Make the on-disk YAML text (as a parsed `yaml.Document[]` AST) the single source of truth for a module. The editor's in-memory `ParsedManifest` becomes a read-only projection derived from that AST. All edits — from the form canvas, from import authoring, from the source view — mutate the AST in place and serialize via the `yaml` library's own `Document#toString()`. The custom YAML generator in `loader.ts` is deleted.

Concretely, this plan fixes four symptoms that all trace back to the same cause:

1. **AI-edited YAML gets clobbered.** The editor holds a `ParsedManifest` in React state and re-writes it on every form edit via a custom serializer. Anything the AI (or the user) added to the file that isn't modeled in `ParsedManifest` — comments, extra documents, formatting — is silently dropped on the next save.
2. **Source view flickers.** [SourceView.tsx:55-61](apps/telo-editor/src/components/views/source/SourceView.tsx#L55-L61) resets the Monaco buffer to the re-serialized canonical YAML whenever `!dirty`. Because the custom serializer normalizes whitespace/quoting, the canonical output differs from the user's text, and the buffer reflows on every pause.
3. **`---` separators disappear.** [buildParsedManifest](apps/telo-editor/src/loader.ts#L646) flattens every document with a recognized `kind` into `{metadata, imports[], resources[]}`. [toManifestDocs](apps/telo-editor/src/loader.ts#L1223) rebuilds a fixed `[module, ...imports, ...resources]` layout. Any extra document (comment-only, a `kind`-less YAML fragment, or multiple resources grouped by user-authored separators) is not tracked and cannot be reproduced.
4. **Comments are stripped.** `d.toJSON()` at [SourceView.tsx:23](apps/telo-editor/src/components/views/source/SourceView.tsx#L23) and the `yaml.Document` → plain object conversion in the analyzer path both drop comment metadata. The custom serializer has no comment storage to emit.

## Non-goals

- **No multi-writer / external edit detection.** File-watching, conflict detection when an external process writes the file between loads, and merge UX are out of scope. They become easier after this refactor (the AST-diff surface makes a 3-way merge tractable) but are deferred to a follow-up.
- **No `yaml`-library-level rewrite of the analyzer.** `@telorun/analyzer` still consumes `ResourceManifest[]` via `.toJSON()` for static analysis. This plan does not change the analyzer contract; the AST layer is an editor-only concern bolted alongside the existing projection.
- **No formatting normalization UI.** We are explicitly not adding a "Format document" button. Users who want a specific style apply it in the source view; the editor preserves whatever is there.
- **Schema form semantics stay the same.** This plan does not change what fields are editable, only how edits are applied. Polymorphic `x-telo-schema-from`, `x-telo-ref`, etc. are untouched.
- **No explicit "remove field" action from the form canvas in v1.** Clearing an input sets the YAML value to an empty string (see null-vs-missing-key convention). A follow-up can add a per-field "remove key" affordance (context menu, trash icon) that emits `undefined` → `delete`. The `diffFields` translator already supports the op; only the canvas UX is deferred.

## Principles

1. **AST is authoritative; `ParsedManifest` is derived.** Every module keeps its `yaml.Document[]` in state. `ParsedManifest` is rebuilt from the AST (cheap — same work `buildParsedManifest` does today on plain objects). Never mutate `ParsedManifest` as a primary action; always mutate the AST and re-derive.
2. **One edit pipeline for all mutations.** Form edits, canvas edits, import authoring, and create-resource all route through a single `applyEdit(doc, pointer, op, value)` helper. The source view is the only path that replaces the AST wholesale — and it does so by re-parsing, not by going through the model.
3. **Serialize with `Document#toString()`.** Delete the custom `pushYaml` / `dumpYamlDoc` / `renderManifestYaml` chain. `yaml` preserves comments, anchors, quoting, flow vs block style, and multi-document separators when you round-trip through `parseAllDocuments` → `toString`.
4. **Never push canonical text back into the source editor buffer.** The source view treats its Monaco buffer as ground truth while focused/dirty. External manifest changes (from the form) only update the buffer when the user is not actively editing this file, and even then we preserve the exact string the AST produces rather than generating a new "canonical" rendering.
5. **Per-file AST granularity.** Multi-file modules (`include:` directives) keep a separate `yaml.Document[]` per file. The current owner-vs-partial split in [getMultiFileSnapshots](apps/telo-editor/src/loader.ts#L1272) becomes unnecessary: each file's AST already tells us what's in it.

## Architectural decisions

- **AST layer location.** Inline in the editor: `apps/telo-editor/src/yaml-document.ts`. The VS Code extension consumes the analyzer path, not the editor's AST, so there is no second consumer today. Surface is small (~300 LOC). Promote to a shared package `@telorun/yaml-ast` the moment a second consumer materializes.
- **`ParsedManifest` shape.** No back-reference on `ParsedManifest`. It stays plain-data — already consumed by analyzer-adjacent code. A side-table on `Workspace` (see below) maps resource identifiers to `(filePath, docIndex)` for O(1) lookup during edits.
- **`manifest.rawYaml`.** Keep the field, but populate only on parse failure. Successful loads leave it `undefined`; the editor reads source text from `ModuleDocument.text`. No UX change to the failed-load banner.
- **Analyzer `Loader` is instantiated fresh per `loadWorkspace` / `analyzeWorkspace` call** and backed by an **in-memory adapter that reads from `workspace.documents`**, not from disk. The analyzer's `Loader.moduleCache` ([analyzer/nodejs/src/manifest-loader.ts:24](analyzer/nodejs/src/manifest-loader.ts#L24)) is `private static readonly` with no invalidation hook; by giving each analysis pass its own instance (static cache is per-class but the instance-scoped `parseCache`/internal state resets) and serving text from the editor's authoritative `ModuleDocument.text`, the cache's `cached.text === text` check works correctly by construction — we always pass the current text, so either the cache hits (correct) or misses (fresh parse). This also decouples static analysis from disk I/O once Phase 1 lands, making analyzer runs deterministic with respect to unsaved AST mutations. The in-memory adapter delegates `expandGlob` to the underlying disk adapter (Tauri / FSA / LocalStorage) since glob resolution still needs the real filesystem; only `read()` is served from memory.
- **`workspace.modules` survives the refactor.** It is not replaced by `workspace.documents`. `workspace.modules` carries graph-derived data (`resolvedPath` for imports, import-resolution enrichment for the analyzer) that the AST alone cannot produce. `workspace.documents` is the mutation target; `workspace.modules` is the analyzer-facing projection. Both are maintained in parallel.

## Data model changes

### New: `ModuleDocument`

A per-file record that pairs each workspace file with its parsed AST. Lives in the workspace state map alongside modules:

```ts
interface ModuleDocument {
  filePath: string;
  /** Exact source text last read from or written to disk. Used to bootstrap
   *  the source view without re-serializing, and to recover the original
   *  text when a parse fails. */
  text: string;
  /** Multi-document AST. Preserves comments, formatting, and arbitrary docs
   *  (including ones with no `kind` field). Empty when `parseError` is set. */
  docs: yaml.Document.Parsed[];
  /** Non-null when parsing failed (syntax error, or docs had `errors[]`).
   *  The ModuleDocument is still created so the source view stays operable
   *  and the user can fix the file. `findDocForResource` returns `undefined`
   *  for these; they are effectively read-only at the AST layer until fixed. */
  parseError?: string;
}
```

`Workspace` gains two fields:

```ts
interface Workspace {
  // ... existing fields
  /** Per-file AST state. Keyed by absolute file path, **normalized via
   *  `normalizePath` from loader.ts** — the same canonical form used by
   *  `getMultiFileSnapshots` to reconcile kernel-stamped `metadata.source`
   *  against `manifest.filePath`. All lookups (`documents.get`,
   *  `resourceDocIndex.get`) go through `normalizePath` first. */
  documents: Map<string, ModuleDocument>;
  /** Per-module side-table mapping `${kind}::${name}` → the document that
   *  contains the resource. Outer key is the owner module's filePath; inner
   *  key scopes resource identity to a single module so `Http.Server/main`
   *  in module A and module B don't collide. Enables O(1) lookup from a
   *  canvas edit to the AST node to mutate. **Rebuilt from scratch** on
   *  every `documents` change — not patched incrementally — because
   *  incremental patching is fragile under resource renames (a
   *  `metadata.name` change shifts the key) and doc-index shifts (add /
   *  remove shifts everything after it). The rebuild is one pass over the
   *  docs array; cheap. */
  resourceDocIndex: Map<string, Map<string, { filePath: string; docIndex: number }>>;
}
```

### Changed: `ParsedManifest`

No shape change in v1. `ParsedManifest` is built from `ModuleDocument.docs` exactly as `buildParsedManifest` builds from `ResourceManifest[]` today — the input is just the AST's `.toJSON()` output. Existing consumers (views, analyzer) see no difference.

What gets removed later (post-v1, once confidence is high): the `rawYaml` field on successful-load manifests, `renderManifestYaml`, `toManifestDocs`, `dumpYamlDoc`, `pushYaml`, `yamlScalar`, `yamlBlockScalar`.

### New: `applyEdit`

Single entry point for mutating the AST. Signature sketch:

```ts
type EditOp =
  | { op: "set"; pointer: string; value: unknown }
  | { op: "delete"; pointer: string }
  | { op: "insert"; pointer: string; value: unknown }  // array append / object add
  | { op: "rename"; pointer: string; newKey: string };

function applyEdit(docs: yaml.Document.Parsed[], docIndex: number, op: EditOp): yaml.Document.Parsed[];
```

Pointer format is a JSON Pointer targeting a path inside `docs[docIndex]`.

**Leaf-scalar mutation preserves comments.** Naive `doc.setIn(path, value)` replaces the node at `path` with a fresh Scalar, which drops the original node's `.comment` / `.commentBefore`. `applyEdit` always calls `doc.getIn(path, true)` first to get the node wrapper. If it's a `Scalar` **and the JS type of `node.value` matches the JS type of the new value** (both `string`, both `number`, both `boolean`, both `null`), mutate `node.value` in place (preserves comment metadata). Only fall back to `setIn` when the target doesn't exist yet (insert), a structural replace is required (non-scalar → scalar or vice versa), or the scalar's type is changing. Scalar type-change (e.g., string `"42"` → number `42`) cannot safely be done in-place — the node's type tag would go stale and future serialization could round-trip incorrectly. The in-place path is type-preserving; everything else goes through `setIn` and accepts the comment loss on that one leaf. `deleteIn` is used for delete; `rename` is modeled as read-value + delete-old-key + setIn-new-key, which loses the comment on the renamed key — acceptable because a rename is an intentional structural change.

**React referential equality.** The `yaml` library mutates AST nodes in place (that's how comments are preserved). React re-renders by reference. These two worlds require an explicit handshake: **every `applyEdit` call produces a fresh `ModuleDocument` object and a fresh `Workspace.documents` Map**, even though the mutation is internally in-place. The `docs` array itself is spread (`[...prev.docs]`) so downstream `useMemo`/`useEffect` consumers that key off `ModuleDocument` or `documents` identity see the change. Without this rule, views render stale data because the outer references never change. It's unavoidable boilerplate — the cost of combining mutation-based YAML with immutable-state React.

**Op ordering invariant.** When `diffFields` emits multiple ops against the same array parent, they **must** be applied in the order `[set ops first, then delete ops]`, with deletes sorted by descending index. This is an explicit invariant enforced by `diffFields` emission order — not inferred at apply time. Reason: array indices shift on delete. Given old `[a, b, c]` and new `[a, c]`, `diffFields` produces `[set /1 = c, delete /2]`. Applying `set` before `delete` is correct (overwrite index 1 with `c`, then remove now-dangling index 2). Applying in the reverse order produces `[set /1 = c, delete /2]` against `[a, b, c]` → delete at 2 gives `[a, b]` then set /1 = c gives `[a, c]` — same result in this case, but the reasoning breaks when deletes share a parent with inserts. The single rule "set before delete, deletes sorted descending" makes all array mutations correct regardless of complexity. `applyEdit` itself is op-agnostic — a single-op call that applies the mutation via `doc.setIn` / `doc.deleteIn` and returns. Ordering lives in the emitter, not the applier.

Resource-level operations:

- **`addResourceDocument(docs, kind, name, fields)`** — appends a new `yaml.Document.Parsed` to the **end** of the docs array. Non-destructive placement; matches what a user expects when creating something new. New resources always land in the **owner file** (the one with the module doc), not in an included partial — same behavior as the current `createModule` / `handleCreateResource`. Moving resources between files is explicitly out-of-scope.
- **`removeResourceDocument(docs, kind, name)`** — removes the whole document from the array.
- **`addImportDocument(docs, name, source, ...)`** — inserts after the last existing `Telo.Import` doc, or immediately after the module doc if none exist. Keeps imports grouped together rather than scattered among resources.
- **`removeImportDocument(docs, name)`** — removes the whole document from the array.

Finding the right `docIndex` for a given resource is an O(1) lookup: `workspace.resourceDocIndex.get(activeModulePath)?.get(`${kind}::${name}`)`.

### Field-diff translator

`handleUpdateResource` receives a new `fields` object from the canvas. A recursive leaf-level diff (`diffFields(oldFields, newFields): EditOp[]`) walks both trees and emits one `set` / `delete` / `insert` op per changed leaf, rooted at the resource's document body. Renames are modeled as delete-then-set (acceptable loss: a comment attached to the renamed key). This preserves interior comments on every edit where the leaf wasn't touched — the alternative (whole-body replace) reintroduces the exact problem this plan fixes for one class of user content. Sketch:

```ts
function diffFields(
  oldVal: unknown,
  newVal: unknown,
  basePointer: string,
): EditOp[];
```

**`null` vs missing key vs empty string convention.** The form canvas distinguishes four JS values in the `fields` object:

- `undefined` → **delete the key**. Emitted only via an explicit "remove field" affordance (deferred to a follow-up; see Non-goals). In v1, user-facing form inputs do not produce `undefined`.
- `null` → **set the key to YAML `null`**. Only emitted when the user explicitly chose null (rare; usually via a "set explicit null" checkbox or similar). Not produced by v1 text/number inputs.
- `""` → **set the key to the empty string `""`**. This is the v1 representation of "cleared input" for string-typed fields. A cleared text input persists as `key: ""` in YAML, not as a deleted key. This is intentional: key-deletion from the canvas is a follow-up capability, and treating cleared inputs as deletions today would make it impossible to ever store an intentional empty string.
- any other value → **set the key to that value**.

`diffFields` follows this: missing-from-new (or `undefined` in new) emits `delete`; `null` in new emits `set` with value `null`; `""` in new emits `set` with value `""`. The canvas must respect this convention.

**Pre-Phase-3 canvas contract fix.** [ResourceCanvas.tsx:45](apps/telo-editor/src/components/views/resource-canvas/ResourceCanvas.tsx#L45)'s `setByPath` currently collapses `null` and `""` to key deletion before the fields object reaches `handleUpdateResource`, silently converting "explicit null" and "cleared string" into "deleted key". This must be changed so `setByPath` passes all three (`null`, `""`, any value) straight through, and only `undefined` triggers key deletion. Audit every form-field component and verify: text / number / textarea inputs that use `""` for the empty state must now emit `""` rather than `undefined`. Key-deletion is reserved for the future explicit "remove field" affordance.

**Arrays are treated positionally (by index), not by identity.** This is a v1 limitation that must be documented clearly in code comments. The consequence:

- Literal arrays (e.g. `targets: [foo, bar]`, `path segments`) behave correctly — positional is their natural semantics.
- Identity-bearing arrays (e.g. `Run.Sequence.steps[]` where each step has a discriminating `name`) lose comment locality on reorder. Reordering step `a` from index 0 to index 2 and step `b` from index 2 to index 0 produces `set` ops at indices 0 and 2 with swapped content, which (via the in-place Scalar mutation from `applyEdit`) misattributes any comment attached to the step-level nodes.
- In-place edits to a step (changing a field without reordering) behave correctly — the index is stable.

Workaround: the canvas already treats `Run.Sequence` steps as named entities; a future follow-up can make `diffFields` identity-aware by declaring a discriminator key per array schema (via an `x-telo-*` annotation), matching old and new items by that key, and emitting move ops as swap-at-identity rather than set-at-index. Out of scope for v1.

Expected size: 60–90 LOC with positional arrays (more than the initial 40 once edge cases around `null`, arrays-of-objects, and nested `undefined` keys are covered). Lives in `yaml-document.ts` next to `applyEdit`.

## Implementation phases

Each phase is independently shippable and reviewable. Landing order matters because later phases depend on the AST layer being present.

### Phase 1 — AST layer, parallel to existing model

**Goal:** every module load populates `workspace.documents` alongside the existing `ParsedManifest`. No behavior change; saves still go through the old path.

Files touched:
- [apps/telo-editor/src/model.ts](apps/telo-editor/src/model.ts) — add `ModuleDocument`, extend `Workspace` with `documents` and `resourceDocIndex`.
- [apps/telo-editor/src/loader.ts](apps/telo-editor/src/loader.ts) — in `loadWorkspace`, after reading each YAML file, also run `parseAllDocuments(text)` and store a `ModuleDocument`. Implement `expandGlob` on `TauriFsAdapter`, `FsaAdapter`, and `LocalStorageAdapter` (see below). Introduce `createInMemoryAdapter(workspace, diskAdapter)` that serves `read()` from `workspace.documents` and delegates `expandGlob` to the underlying disk adapter.
- New: [apps/telo-editor/src/yaml-document.ts](apps/telo-editor/src/yaml-document.ts) — `parseModuleDocument(text)`, `serializeModuleDocument(docs)`, `findDocForResource(docs, kind, name)`.

**Pre-requisite: `expandGlob` on all three editor adapters.** `ManifestAdapter.expandGlob` is optional on the analyzer interface ([analyzer/nodejs/src/types.ts:52](analyzer/nodejs/src/types.ts#L52)), and `resolveIncludes` ([analyzer/nodejs/src/manifest-loader.ts:165](analyzer/nodejs/src/manifest-loader.ts#L165)) throws when an include contains a glob pattern (`*`, `?`, `**`) but the adapter lacks support. `TauriFsAdapter`, `FsaAdapter`, and `LocalStorageAdapter` all currently lack this method. Modules using `include: ["./routes/*.yaml"]` fail to load at all today and will silently produce incomplete `ModuleDocument` maps under Phase 1. Implement `expandGlob` on all three before the rest of Phase 1 ships:

- `TauriFsAdapter.expandGlob` — use `@tauri-apps/plugin-fs` `readDir` + minimatch-style pattern matching.
- `FsaAdapter.expandGlob` — walk `FileSystemDirectoryHandle` children; minimatch-style filter.
- `LocalStorageAdapter.expandGlob` — iterate all keys with the workspace prefix; minimatch-style filter.

**Path canonicalization at every `workspace.documents` / `resourceDocIndex` boundary.** Every `documents.set`, `documents.get`, `resourceDocIndex.set`, and `resourceDocIndex.get` call MUST route its key through `normalizePath` from [loader.ts](apps/telo-editor/src/loader.ts) first. The analyzer stamps `metadata.source` with whatever absolute path the adapter returns, which may contain `./`, `..`, or trailing slashes; `normalizePath` collapses these. Without strict enforcement, `documents.get` lookups miss non-deterministically depending on how callers construct paths. Add a unit test that loads a module with `/foo/./bar/telo.yaml`-style paths and asserts the lookup still resolves.

**Reusing the analyzer's include resolution.** The analyzer's `Loader` owns glob expansion for `include:` via [resolveIncludes](analyzer/nodejs/src/manifest-loader.ts#L165). We do not duplicate that logic. Instead:

- Instantiate a **fresh analyzer `Loader`** per `loadWorkspace` call (no long-lived shared instance), backed by the **in-memory adapter** described in Architectural decisions.
- After the `Loader` returns the combined `ResourceManifest[]` for a module, walk it to extract the set of distinct `metadata.source` values — those are the owner + all partial file paths actually consumed.
- For each distinct source path (canonicalized via `normalizePath`), read the raw text via the **disk** adapter (first load only — `workspace.documents` doesn't exist yet) and call `parseAllDocuments(text)` to build that file's `ModuleDocument`. Subsequent re-analyses read from `workspace.documents` via the in-memory adapter.
- This keeps glob / path resolution logic in exactly one place (the analyzer) and guarantees the editor's per-file ASTs match the analyzer's view of the module.

Acceptance:
- Opening any workspace populates `state.workspace.documents` for every module file, including `include:`-expanded partials and glob-expanded partials.
- A module with `include: ["./routes/*.yaml"]` loads successfully across all three adapters.
- A module loaded with `/foo/./bar/telo.yaml` resolves via `resourceDocIndex` lookup keyed with `/foo/bar/telo.yaml`.
- Round-trip `parseModuleDocument(text) → serializeModuleDocument(docs)` preserves comments, separators, and key order on fixtures containing all of: comments, multi-doc separators in odd positions, `kind`-less documents, and block + flow mixed styles. **Byte-identical is not required** — see Phase 2 for why.
- No change to any view.

### Phase 2 — New save path, feature-flagged

**Goal:** flip saves to go through the AST. Keep the old save path behind a flag so we can fall back if a manifest shape isn't round-trippable yet.

**Flag mechanics.** Hardcoded boolean constant `USE_AST_SAVE` at the top of `loader.ts`. Default `false` when the PR opens so the AST write path can be exercised in dev without affecting the user. Flipped to `true` in the **same PR** once acceptance tests pass — if we can't flip it, Phase 2 isn't done and doesn't merge. Not user-facing (no setting, no env var). Deleted entirely in Phase 5.

Files touched:
- [apps/telo-editor/src/loader.ts](apps/telo-editor/src/loader.ts) — new `saveModuleFromDocuments(workspace, filePath, adapter)`: looks up each file's `ModuleDocument`, serializes via `serializeModuleDocument(docs)` from the AST layer, writes only files whose serialized text differs from the stored `text`.
- [apps/telo-editor/src/components/Editor.tsx:370](apps/telo-editor/src/components/Editor.tsx#L370) — `persistModule` takes a workspace + filePath instead of a `ParsedManifest`, routes to the new save path.

**Serialization format.** `serializeModuleDocument` sets `doc.directives.docStart = true` on every doc before stringifying, then joins with `"\n"`:

```ts
function serializeModuleDocument(docs: yaml.Document.Parsed[]): string {
  for (const d of docs) d.directives.docStart = true;
  return docs.map(String).join("\n");
}
```

This produces deterministic output (every doc is preceded by `---`, including the first) and is immune to `yaml` library formatting changes. The alternative — prepend `"---\n"` for `i > 0` and strip a duplicate when `String(d)` already emitted one — depends on the library's internal formatting behavior and is fragile under version upgrades. The cost is a leading `---` on the first document, which is a one-time cosmetic shift users barely notice and that tracks the standard multi-document YAML convention anyway.

**Byte-identical round-trip is not a goal.** The `yaml` library normalizes certain aspects on `String(doc)` regardless of whether anything was mutated — trailing newlines, specific quoting choices on scalars that are valid both ways, etc. Chasing byte-identical reformats into a rabbit hole. Instead, the no-op write guard compares *semantically*:

- `saveModuleFromDocuments` skips the write when `docs[i].toJSON()` deep-equals the `.toJSON()` produced on initial load (stored in `ModuleDocument.loadedJson`, captured once in Phase 1). This catches "nothing actually changed" without depending on string formatting.
- Trade-off: the very first save of a non-canonically-formatted file reformats it. We accept this as a one-time cost. It surfaces to the user as a normal save (no warning, no prompt) because after that save, the file is in canonical form and future round-trips are stable.

`ModuleDocument` gains:

```ts
  /** Semantic snapshot of `docs.map(d => d.toJSON())` at load time. Used as
   *  the oracle for no-op write detection — compared against the current
   *  AST's `.toJSON()` on save. Does not include comments, so it's cheap.
   *
   *  STABILITY ASSUMPTION: `toJSON()` output must be stable across `yaml`
   *  library versions for this guard to be correct. A library upgrade that
   *  changes scalar-type coercion or merge-key handling could cause
   *  `loadedJson` captured under the old version to diverge from a re-parse
   *  under the new version, triggering spurious reformats on first save.
   *  Unlikely in practice for a well-maintained library; flag this if a
   *  `yaml` major-version bump is pending. */
  loadedJson: unknown[];
```

Acceptance (all three adapters — Tauri, FSA, LocalStorage):
- A manifest loaded and immediately saved, with no edits, produces zero writes (semantic equality guard).
- A manifest with comments and an extra `kind`-less document survives a save round-trip.
- A manifest using glob `include:` patterns loads completely and saves without data loss on non-owner partials.
- Multi-file modules: each file's partial AST is saved independently; no data is duplicated into the owner file.
- A non-canonically-formatted file reformats exactly once on its first write; subsequent no-op saves stay silent.

### Phase 3 — Form edits route through AST

**Goal:** every form-driven mutation (`handleUpdateResource`, `handleAddImport`, `handleRemoveImport`, `handleUpgradeImport`, `handleCreateResource`) applies to the AST, not to `ParsedManifest`. The `ParsedManifest` used by views is re-derived from the mutated AST.

Files touched:
- [apps/telo-editor/src/yaml-document.ts](apps/telo-editor/src/yaml-document.ts) — add `applyEdit` and resource-level helpers (`addResourceDocument`, `removeResourceDocument`, `setResourceField`, `addImportDocument`, `removeImportDocument`).
- [apps/telo-editor/src/components/Editor.tsx](apps/telo-editor/src/components/Editor.tsx) — rewrite `handleUpdateResource` (the big one): given `(kind, name, fields)`, diff the new fields against the current resource's AST node, translate diffs to `applyEdit` ops, apply, re-derive `ParsedManifest`, set state.
- [apps/telo-editor/src/components/views/resource-canvas/ResourceCanvas.tsx](apps/telo-editor/src/components/views/resource-canvas/ResourceCanvas.tsx) — two changes:
  1. **`setByPath` contract change** at [line 45](apps/telo-editor/src/components/views/resource-canvas/ResourceCanvas.tsx#L45): stop collapsing `null` / `""` to deletion. Only `undefined` deletes the key. Audit every form-field component to confirm cleared text / number inputs emit `""` (for strings) or `null` / appropriate zero-value (for typed fields), **never** `undefined` in v1. This is the hard gate for the null-vs-missing-key convention described above.
  2. **`useEffect` dependency tightening** at [lines 91-93](apps/telo-editor/src/components/views/resource-canvas/ResourceCanvas.tsx#L91-L93): change from `[resource]` to `[resource.kind, resource.name]`. Once Phase 3 lands, every `applyEdit` produces a new `ParsedManifest`, a new `ParsedResource` object reference, and re-triggers the resync effect under the current deps — rolling back in-flight keystrokes. Keying on resource identity (kind + name) means the resync fires only on selection change, matching the "user typing wins until commit" rule used by the source view.

Acceptance:
- Editing a single field via the canvas preserves every comment elsewhere in the document.
- Adding an import via the import authoring flow appends a new `Telo.Import` document with library-default formatting (two-space indent, unquoted scalars where safe) — we accept "library default" as the v1 output style for authored content.
- Removing an import removes only its document and the surrounding `---`, leaving the rest of the file intact.

Edge cases to test:
- Field rename (key change) — currently handled in schema forms; verify `applyEdit` "rename" op preserves the node's comment.
- In-place edit to a single step of `Run.Sequence` (change a field without reordering) — comment locality preserved via in-place Scalar mutation.
- Deleting a field that has a comment attached — the comment should go with the field, not orphan onto the next key.

Known limitation (not a passing test — see the positional-array callout in the `applyEdit` section): reordering identity-bearing array items (e.g., `Run.Sequence` steps by `name`) loses comment locality in v1. Adding a test that asserts this is the current behavior is fine so regressions don't silently improve or worsen it; just don't frame it as "should preserve comments on reorder."

**Derived-from-graph fields in re-projection.** `ParsedImport.resolvedPath` is not in the YAML — it's computed by the import-resolution pass (phase 2b of `loadWorkspace`) that walks the file system / registry to find the imported module's `telo.yaml`. A naive re-projection from the AST alone produces `ParsedImport { resolvedPath: undefined }` for every import, breaking topology, kind lookup, and the WorkspaceTree.

Rule: `rebuildManifestFromDocuments(docs, prev: ParsedManifest)` preserves graph fields by carrying them forward from `prev` wherever the AST-derived import matches on `name` + `source`. Changed-source imports trigger reconciliation automatically — the source view must never require an "also call reconcile" dance, because users will edit `source:` directly in YAML. Specifically:

- Diffs `prev.imports` against AST-derived `next.imports` by `name`.
- For each unchanged import (same `name` + `source`), copies `resolvedPath` forward.
- For each changed-source import, sets `resolvedPath = undefined` and marks the manifest as needing reconciliation.
- Editor dispatches `reconcileImports(workspace, activeModulePath, ...)` whenever the re-derivation returns at least one unresolved import. Same function Editor already calls from `handleReplaceManifest`.

Both form-side (`addImport` / `handleUpgradeImport`) and source-side (raw YAML edit) import changes converge through this single reconciliation path.

### Phase 4 — Source view stops round-tripping, per-tab editing for multi-file modules

**Goal:** eliminate the flicker, and make every file in a multi-file module editable via its own tab — not just the owner file.

Files touched:
- [apps/telo-editor/src/components/views/source/SourceView.tsx](apps/telo-editor/src/components/views/source/SourceView.tsx) — delete the `useEffect` at [lines 55-61](apps/telo-editor/src/components/views/source/SourceView.tsx#L55-L61) that resets `localText`. Remove the read-only branch at [line 177](apps/telo-editor/src/components/views/source/SourceView.tsx#L177). Rebuild around per-tab state (see below).
- [apps/telo-editor/src/components/views/types.ts](apps/telo-editor/src/components/views/types.ts) — replace the shared `onReplaceManifest(manifest: ParsedManifest)` prop with `onSourceEdit(filePath: string, text: string)`. All views that currently receive `onReplaceManifest` switch to the new prop. If other views don't need it, scope it to a `SourceViewProps extends ViewProps` narrowing instead of leaving it on the shared interface.
- Kill `parseYamlToManifests` + `buildParsedManifest` + `onReplaceManifest` round-trip. Instead, `onSourceEdit(filePath, text)` passes the edited text up; Editor replaces the `ModuleDocument` for that file and rebuilds the projection.
- [apps/telo-editor/src/components/Editor.tsx:580](apps/telo-editor/src/components/Editor.tsx#L580) — `handleReplaceManifest` → `handleSourceEdit(filePath, text)`. Remove the old callback.

**Multi-file source view — tab model.** For a module with the owner file plus N partial files, the source view renders N+1 tabs (VS Code-style). Each tab has:

- Its own `localText` state (seeded from `ModuleDocument.text` on first activation).
- Its own `dirty` flag (true once the user types, false after a successful parse-and-save).
- Its own 500ms debounce timer (no change to debounce timing).
- Its own Monaco model — instantiate one `ITextModel` per file path and keep it alive while the module is open, so switching tabs restores cursor position and undo history without re-parsing.

State shape: a `Map<filePath, { localText, dirty, debounceTimer }>` held at the SourceView root, keyed by canonical `normalizePath(filePath)`. Monaco's `editor.setModel(models.get(activeFilePath))` swaps the active buffer on tab change. Owner-file and partial-file tabs are indistinguishable in behavior — the distinction only exists in the analyzer's module grouping, not in the editor's source UX.

**Staleness rule for cross-view edits.** A form edit to a resource while the source view is open-but-not-dirty mutates the AST of a specific file, which means that file's Monaco buffer is now stale relative to `ModuleDocument.text`. The rule applies **per tab**:

- Tab for file X has `dirty === true`: form edits targeting file X are still applied to the AST (writing through), but tab X's Monaco buffer is never touched. The two views are temporarily divergent for that file. Committing tab X (debounce fires + parse succeeds) wins — it replaces `ModuleDocument.docs` for file X, overwriting the form's AST-level changes to that file. This is acceptable because the user was actively editing that file's source; they expect their typed text to be authoritative.
- Tab for file X has `dirty === false`: when a form edit lands on file X, after the AST mutation we serialize the updated docs and push the new text into tab X's Monaco model via `model.setValue(newText)`. No flicker because no typing is in flight in that tab. Cursor position is preserved by Monaco's default `setValue` behavior.
- **Cross-file form edits never touch sibling tabs.** A form edit targeting file X leaves tabs for other files in the same module untouched, regardless of their dirty state. The form only mutates the specific file that owns the edited resource, looked up via `resourceDocIndex.get(modulePath).get(kind::name).filePath`.

Stated differently: **the dirty flag is the arbiter of authority, per file.** A dirty tab owns its file's text until it commits or the user discards; a non-dirty tab tracks its file's AST.

**Parse failure in the source view.** When the debounce fires for a tab and `parseAllDocuments` returns errors, or any resulting `Document` has a non-empty `errors[]`:

- `ModuleDocument.docs` for that file is NOT replaced — stays as the last successfully parsed version.
- `ModuleDocument.parseError` is set for that file; the corresponding tab shows a red marker with the error message (existing Monaco marker behavior).
- No write to disk. The tab stays dirty.
- The form / topology / inventory views keep working against the last-good AST for that file. Note there's an intentional divergence: the form shows yesterday's good state while the source view shows today's broken text. Acceptable because (a) the user is clearly editing, (b) it's the only way to not silently lose their typing.
- Sibling tabs (other files in the same module) are unaffected.
- When the user fixes the error and the next debounce-fire parses clean, `ModuleDocument.docs` for that file updates, the write lands, and the marker clears.

**Switching tabs / switching modules while a tab is dirty.** The rule depends on whether the user is moving within the source view or leaving it:

- **Switching tabs within the same module's source view**: no flush required. The tab's `localText` and `dirty` state persist; its debounce timer continues running in the background. Switching back restores the in-progress edit. Rationale: the user hasn't committed anything, and Monaco's `model` persistence plus per-tab state makes continuity cheap.
- **Switching modules, closing the source view, or closing the workspace**: for every dirty tab, fire the debounced parse immediately (cancel the timer and run synchronously). If parse succeeds, save and proceed. If any tab fails to parse, block the switch and surface the error — a toast ("Fix YAML errors in \<filename\> before switching") plus the Monaco marker on the offending tab is enough. The user has two escape routes: fix the error, or manually revert the buffer (future: an explicit Discard action; not in this plan).

**Debounce timing.** Keep the existing 500ms debounce. No change as part of this refactor.

Acceptance:
- Typing `---` on a blank line does not get reformatted or removed.
- Typing `# a comment` survives indefinitely.
- Adding `foo: bar` as a standalone document (no `kind`) is preserved in the file and visible in the source view forever (though not rendered in topology/inventory, since it has no kind).
- No buffer reflow while the user is actively typing.
- Form edit lands while the target file's tab is open-but-not-dirty: that tab reflects the change after the next render; its buffer content matches the just-written disk text.
- Form edit lands while the target file's tab is dirty: the tab's Monaco buffer is untouched; committing the source edit overwrites the form change (last-writer-wins by explicit rule).
- Multi-file module: edits in tab A do not cause tab B's buffer to reflow, whether B is dirty or not.
- Multi-file module: switching tabs within the module preserves each tab's local edit state and dirty flag.
- Typing invalid YAML in one tab: that tab's marker appears; disk is not written for that file; sibling tabs and form/topology views keep working against the last-good AST; fixing the error clears the marker and writes to disk.
- Attempting to switch modules while any tab is dirty and invalid: the switch is blocked, the offending tab is focused, and the user is shown where to fix.

### Phase 5 — Remove the custom serializer

**Goal:** delete the dead code. Two non-save consumers of the old serializer need replacements first — neither is touched by Phases 1–4, so this phase handles both.

**5a. Replace `toManifestDocs` in the analyzer path.** [analysis.ts:23](apps/telo-editor/src/analysis.ts#L23) calls `toManifestDocs(manifest)` per module and enriches each doc's metadata with `source`, `resolvedModuleName`, `resolvedNamespace` before feeding `StaticAnalyzer`. With the AST layer in place:

- Add `toAnalysisManifest(doc: yaml.Document.Parsed): ResourceManifest` to `yaml-document.ts` — really just `doc.toJSON()` with a cast, since the analyzer already consumes this shape from the loader on its own path.
- Rewrite `toAnalysisManifests` in [analysis.ts](apps/telo-editor/src/analysis.ts) to iterate `workspace.modules` (**not** `workspace.documents`) as the outer loop. For each `ParsedManifest`:
  - Collect all source paths that belong to this module: the owner file path plus every partial resolved through `manifest.include`.
  - For each source path (canonicalized via `normalizePath`), look up the `ModuleDocument` via `workspace.documents.get(normalizePath(path))` and call `toAnalysisManifest(doc)` on every doc in that file.
  - Flatten the per-file docs into a single `ResourceManifest[]` for the module and apply the same `meta.source` / `meta.resolvedModuleName` / `meta.resolvedNamespace` enrichment.
- Rationale: `workspace.documents` is keyed per-file. The analyzer expects per-module-flattened doc arrays; feeding it partial-file docs as standalone entries breaks the module-identity pass (the pass that determines which `metadata.namespace` and module name govern each resource). Iterating `workspace.modules` preserves exactly the grouping `toManifestDocs` produced today.
- Import resolution still reads from `workspace.modules[].imports` to find the resolved target. `workspace.modules` is NOT deprecated by this refactor — it is the analyzer-facing projection that carries graph-derived data (`resolvedPath`, resolved module name/namespace) the AST alone cannot produce.
- No change to the analyzer contract — it still receives `ResourceManifest[]` with the same enriched metadata.

**5b. Replace `renderManifestYaml` in `createModule`.** [loader.ts:995](apps/telo-editor/src/loader.ts#L995) uses the renderer to produce initial text for a brand-new empty module (no AST yet). Replacement: build a `yaml.Document` programmatically.

- Add `buildInitialModuleDocument(kind, name): yaml.Document` to `yaml-document.ts`.
- Initial doc body is exactly:
  ```ts
  {
    kind: kind === "Application" ? "Telo.Application" : "Telo.Library",
    metadata: { name, version: "1.0.0" },
  }
  ```
  No `targets:` field for Applications. This mirrors the current renderer's behavior: [toManifestDocs:1237](apps/telo-editor/src/loader.ts#L1237) guards `targets` on `manifest.targets.length > 0`, so a fresh Application never emits it. An empty `targets: []` would be a visible regression in initial file content.
- `createModule` serializes via `serializeModuleDocument([initialDoc])` and writes. It also populates `workspace.documents` for the new file so subsequent edits go through the AST path directly.
- Acceptance: byte-compare the output of the new path against the old `renderManifestYaml` for both kinds on an empty `createModule` call. They should match exactly — if they diverge, fix this before landing Phase 5.

**5c. Delete the custom serializer and update all remaining consumers.**

Files touched:
- [apps/telo-editor/src/loader.ts:1122-1314](apps/telo-editor/src/loader.ts#L1122-L1314) — delete `YAML_QUOTE_REQUIRED`, `needsYamlQuote`, `yamlScalar`, `yamlBlockScalar`, `pushYaml`, `dumpYamlDoc`, `toManifestDocs`, `renderManifestYaml`, `getMultiFileSnapshots`. `saveModule` now wraps `saveModuleFromDocuments`.
- [apps/telo-editor/src/loader.ts `deleteModule`](apps/telo-editor/src/loader.ts#L1026) — at [line 1044](apps/telo-editor/src/loader.ts#L1044) it currently calls `saveModule(updated, adapter)` to persist each importer after pruning a `Telo.Import` reference. Route through `saveModuleFromDocuments(workspace, importerPath, adapter)` instead. Additionally, after pruning a module, remove the corresponding entries from `workspace.documents` and `workspace.resourceDocIndex` (keyed by `normalizePath(filePath)`) to avoid map growth and stale lookups.
- [apps/telo-editor/src/analysis.ts](apps/telo-editor/src/analysis.ts) — switch to `toAnalysisManifest` per 5a.
- [apps/telo-editor/src/loader.ts:createModule](apps/telo-editor/src/loader.ts#L995) — switch to `buildInitialModuleDocument` + `serializeModuleDocument` per 5b.
- Any test fixtures that depend on the old serializer's exact output — regenerate golden files from the new path.

Acceptance:
- `grep -r "renderManifestYaml\|toManifestDocs\|pushYaml\|dumpYamlDoc" apps/telo-editor/src` returns nothing.
- Full test suite passes with `pnpm run test`.
- Analyzer diagnostics for a fixture workspace are identical before vs. after Phase 5 (byte-compare the `diagnosticsByResource` output for a fixed input).
- Creating a new module via the editor produces a valid, loadable manifest and subsequent edits land on its AST.
- Deleting a module prunes its entries from `workspace.modules`, `workspace.documents`, and `workspace.resourceDocIndex`; the follow-up importer save uses `saveModuleFromDocuments`.

## Testing strategy

- **Unit:** `yaml-document.ts` round-trip tests with fixture files containing comments, multi-doc, `---` separators in odd positions, anchors/aliases, block and flow styles, `kind`-less documents.
- **Integration (editor):** open a manifest, edit a field via the canvas, verify: (a) the edited field changed in the on-disk YAML, (b) every comment in the file is still present (string-search for comment contents), (c) every unrelated document's `.toJSON()` is unchanged from its pre-edit value. Byte-equality on the surrounding bytes is **not** asserted — Phase 2's semantic-equality pivot explicitly allows the first save to normalize formatting. What must hold is that semantic content outside the edit target is unchanged, and comments survive.
- **Integration (end-to-end flicker):** open the source view, type `---` followed by `kind: Foo\nmetadata:\n  name: bar`, wait past the debounce, verify the Monaco buffer still shows what the user typed (no reflow).
- **Agent workflow:** write a manifest externally with comments + a custom document, open it in the editor, edit one resource field, close, verify the external content is still there. This is the original user complaint — it belongs as an explicit regression test.

## Out of scope / follow-ups

- External file-watch + reload/merge UX.
- VS Code extension parity (shares the same pain but has its own rendering pipeline).
- "Format document" action.
- First-class UI for `kind`-less documents (they're preserved but not visible in topology/inventory).
- Moving resources between files (the owner file vs. included partials).
- **Explicit "remove field" canvas affordance** — context menu, trash icon, or equivalent that emits `undefined` from the canvas to trigger key deletion. `diffFields` and `applyEdit` already support the `delete` op; only the canvas UX is deferred. Until this lands, a cleared input persists as `key: ""` rather than a missing key.
- **Identity-aware array diffing.** v1 treats arrays positionally, so reordering identity-bearing array items (e.g., `Run.Sequence` steps by `name`) loses comment locality. Follow-up introduces an `x-telo-*` discriminator annotation so `diffFields` can match old/new items by identity and emit move-at-identity rather than set-at-index.
- **Analyzer debounce optimization.** Every `applyEdit` currently triggers the 300ms analysis debounce. Not worse than today, but post-Phase-3 the trigger frequency from form edits is identical to keystroke rate. A follow-up can skip re-analysis when no doc's `.toJSON()` changed shape (only scalar values moved).
