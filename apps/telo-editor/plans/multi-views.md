# Editor Views — Implementation Plan

Goal: introduce a stable data contract (`ModuleViewData`) that all current and future views consume, then build the inventory view as the first new consumer. Each step leaves the codebase in a working state.

**Encapsulation rule:** Views are self-contained. `ViewContainer` and `Editor.tsx` know nothing about a view's internal logic. Every view receives the same shared contract (`ModuleViewData` + selection state + common callbacks) and derives everything it needs internally. Adding a future view is purely additive — new directory under `views/`, register in `ViewContainer` — zero changes to `ViewContainer`'s or `Editor`'s interfaces.

Target directory structure after all steps:

```
src/components/
  views/
    ViewContainer.tsx       ← view multiplexer (tabs + active view)
    types.ts                ← shared ViewProps interface
    inventory/
      InventoryView.tsx
    topology/
      TopologyView.tsx
      RouterTopologyCanvas.tsx
      SequenceTopologyCanvas.tsx
```

App-lifecycle states (no application, creating) are handled by `Editor.tsx` above `ViewContainer`. `ViewContainer` only renders when there is an active application — it is purely a view multiplexer.

---

## Step 1 — Add types to `model.ts`

Add three things:

```ts
type ViewId = "topology" | "inventory";

interface ModuleViewData {
  manifest: ParsedManifest;
  kinds: Map<string, AvailableKind>;              // fullKind → merged local + imported
  diagnostics: Map<string, AnalysisDiagnostic[]>; // resourceName → issues
}
```

`ModuleViewData.diagnostics` is a flat map (resourceName → issues), projected from the nested `EditorState.diagnosticsByResource` (modulePath → resourceName → issues) for the active module. The projection happens in `buildModuleViewData` (step 3).

Add `activeView: ViewId` to `EditorState`. Update `INITIAL_STATE` in `Editor.tsx` with `activeView: "topology"` to preserve current behavior.

No visual change. All existing code still compiles.

---

## Step 2 — Persist `activeView`

In `storage.ts`:

- Add `activeView?: string` to `PersistedState`.
- Serialize it in `saveState`.
- Deserialize with validation: check that the value is a known `ViewId`, otherwise fall back to `"topology"`. This handles both missing values (old localStorage) and invalid values (removed view type from a future version).

No visual change. Existing localStorage payloads gain the field on next save.

---

## Step 3 — Extract `buildModuleViewData()`

Create `src/view-data.ts` with a pure function:

```ts
function buildModuleViewData(
  application: Application,
  manifest: ParsedManifest,
  moduleDiagnostics: Map<string, AnalysisDiagnostic[]> | undefined,
): ModuleViewData
```

The third parameter is the inner map from `EditorState.diagnosticsByResource.get(activeModulePath)` — the caller unwraps the outer map by module path. This keeps `buildModuleViewData` unaware of the nested storage structure.

This absorbs the inline computation block in `Editor.tsx` (lines ~364-406) that builds `availableKinds`, `localKinds`, `schemaByKind`, `kindByFullKind`, `capabilityByKind`. The merged `kinds` map (local + imported kinds unified) replaces all of them.

In `Editor.tsx`, call `buildModuleViewData` and derive the old prop shapes from its output so downstream components (`DetailPanel`, `Sidebar`) stay unchanged for now:

```ts
const viewData = state.application && activeManifest
  ? buildModuleViewData(
      state.application,
      activeManifest,
      state.diagnosticsByResource.get(state.activeModulePath!),
    )
  : null;

// Derive legacy shapes for DetailPanel/Sidebar until they migrate (step 7)
const schemaByKind: Record<string, Record<string, unknown>> = Object.fromEntries(
  [...(viewData?.kinds ?? [])].map(([k, v]) => [k, v.schema]),
);
const capabilityByKind: Record<string, string> = Object.fromEntries(
  [...(viewData?.kinds ?? [])].filter(([, v]) => v.capability).map(([k, v]) => [k, v.capability]),
);
const resolvedResources: ResolvedResourceOption[] = (viewData?.manifest.resources ?? []).map(r => ({
  kind: r.kind,
  name: r.name,
  capability: viewData?.kinds.get(r.kind)?.capability,
}));
```

**Sidebar `availableKinds`:** The unified `viewData.kinds` map includes both imported and local kinds. Previously, Sidebar received only imported kinds from `getAvailableKinds()` and local kinds were a separate inline computation used only for schema/capability lookups. To avoid a behavioral change in step 3 (e.g., the "Create Resource" dropdown showing locally-defined kinds), continue passing the old `getAvailableKinds()` array to Sidebar until step 7, where Sidebar migrates to `ModuleViewData` and the unified behavior is explicitly adopted:

```ts
// Keep old array for Sidebar until step 7
const availableKinds = state.application && activeManifest
  ? getAvailableKinds(state.application, activeManifest)
  : [];
```

The topology-specific derivations (`graphResource`, `graphKind` at lines ~391-397) are **removed** from `Editor.tsx` — they move into `TopologyView` in step 4.

No visual change. Same data, different source.

---

## Step 4 — Create `views/` directory, move topology files, add `ViewContainer`

This step establishes the directory structure and introduces the view container.

### 4a — Define shared `ViewProps`

Create `src/components/views/types.ts` with the common props interface that every view receives:

```ts
interface ViewProps {
  viewData: ModuleViewData;
  selectedResource: { kind: string; name: string } | null;
  graphContext: { kind: string; name: string } | null;
  onSelectResource: (kind: string, name: string) => void;
  onNavigateResource: (kind: string, name: string) => void;
  onUpdateResource: (kind: string, name: string, fields: Record<string, unknown>) => void;
  onSelect: (selection: Selection) => void;
  onClearSelection: () => void;
}
```

`graphContext` is the "canvas focus" resource — the resource the user was last working with in a canvas view. It is **not** topology-specific: topology uses it to know which resource to render, inventory uses it to show which resource has canvas focus (amber highlight, matching sidebar behavior), and the future workflow view will use it to center/highlight a node.

`ViewContainer` passes the same `ViewProps` to whichever view is active — it doesn't branch or filter per view. Views use what they need and ignore the rest.

Note: sub-resource pointer selection (`Selection` with JSON pointer) only flows to `DetailPanel`, not to views. Views receive `selectedResource` (resource-level) for row/node highlighting. If a future view needs pointer-level highlighting, `Selection` can be added to `ViewProps` as an additive change.

### 4b — Move topology files and make `TopologyView` self-contained

- Move `GraphCanvas.tsx` → `views/topology/TopologyView.tsx` (rename component to `TopologyView`).
- Move `RouterTopologyCanvas.tsx` → `views/topology/RouterTopologyCanvas.tsx`.
- Move `SequenceTopologyCanvas.tsx` → `views/topology/SequenceTopologyCanvas.tsx`.
- Update internal imports within the three files.

Change `TopologyView` to accept `ViewProps` and derive its internals:

- Compute `graphResource` from `viewData.manifest.resources` + `graphContext` (was in `Editor.tsx`).
- Compute `graphSchema` / `graphTopology` from `viewData.kinds.get(graphResource.kind)` (was in `Editor.tsx`).
- Route to `RouterTopologyCanvas` / `SequenceTopologyCanvas` as before — this is internal to topology, invisible to `ViewContainer`.

The "no application" and "creating" empty states are **removed** from `TopologyView`. These are app-lifecycle concerns handled by `Editor.tsx` before `ViewContainer` renders (see 4c).

### 4c — Create `ViewContainer`

Create `src/components/views/ViewContainer.tsx`.

Props:

```ts
interface ViewContainerProps {
  activeView: ViewId;
  onChangeView: (view: ViewId) => void;
  viewProps: ViewProps;
}
```

`ViewContainer` receives `ViewProps` as a single bundled object and forwards it wholesale. Its prop surface is narrow: `activeView`, `onChangeView`, `viewProps` — three props total.

Internally it renders:

1. A view tab bar (topology | inventory).
2. The active view component, passing `viewProps` through.

For now inventory tab renders a placeholder `<div>`.

`ViewContainer` does **not** handle app-lifecycle states (no application, creating). Those stay in `Editor.tsx`, which conditionally renders either the lifecycle UI or `<ViewContainer />`. This keeps `ViewContainer` as a pure multiplexer.

`Editor.tsx` replaces the `<GraphCanvas .../>` block with:

- If no application or creating: render lifecycle UI (empty state / create form) directly.
- Otherwise: render `<ViewContainer activeView={...} onChangeView={...} viewProps={...} />`.

`handleNavigateResource` in `Editor.tsx` is updated to also set `activeView: "topology"` — navigating to a resource's canvas implies switching to topology view.

Visual change: tab bar appears above the canvas area. Clicking "Inventory" shows an empty placeholder. Clicking "Topology" shows the current canvas. Everything else unchanged.

---

## Step 5 — `InventoryView` component

Create `src/components/views/inventory/InventoryView.tsx`. It accepts `ViewProps`.

Layout: a scrollable area with two groups, each rendered as a compact table.

**User resources group** — resources where `!kind.startsWith("Kernel.")`:

| Column | Source |
|--------|--------|
| Name | `resource.name` |
| Kind | `resource.kind` (styled as `Alias.KindName`) |
| Capability | `viewData.kinds.get(resource.kind)?.capability` — badge |
| Topology | `viewData.kinds.get(resource.kind)?.topology` — badge if present |
| Diagnostics | icon + red left border when `viewData.diagnostics.get(resource.name)` is non-empty |

**Definitions group** — resources where `kind === "Telo.Definition"`:

| Column | Source |
|--------|--------|
| Name | `resource.name` |
| Capability | `resource.fields.capability` — badge |
| Topology | `resource.fields.topology` — badge if present |
| Diagnostics | same as above |

`Telo.Module` and `Telo.Import` resources are **not shown** — they are structural metadata already visible in the sidebar's Modules and Imports sections. The inventory shows only resources that the user creates and edits.

Clicking a row calls `onSelectResource` (opens detail panel). If the resource has topology, show a small icon/button that calls `onNavigateResource` (switches to topology view and opens that resource's canvas — see step 4c for the view switch behavior).

Resources where `graphContext` matches get an amber highlight (matching the sidebar's existing behavior at `Sidebar.tsx:591`), indicating canvas focus.

Unknown kinds (where `viewData.kinds.get(resource.kind)` returns `undefined`) render with the raw kind string and empty capability/topology columns. Diagnostics handle the visual warning.

Empty state: "No resources — use the sidebar to create one."

Wire into `ViewContainer`: replace the placeholder with `<InventoryView />`.

---

## Step 6 — Diagnostics rendering in inventory

Add diagnostic indicators to `InventoryView`:

- Resources with diagnostics get a warning icon in the diagnostics column and a red/amber left border on their row.
- Hover/click the icon to see diagnostic messages (tooltip or expandable row).

Topology canvases (`RouterTopologyCanvas`, `SequenceTopologyCanvas`) don't need changes yet — diagnostic rendering for topology is a separate task. Diagnostics data is already available in `ViewProps` for when it's needed.

Note: `diagnosticsByResource` in `EditorState` is currently always empty (analysis pipeline not wired). The UI renders the indicators when data is present but shows nothing when the map is empty. This is correct — diagnostics will light up with real data after step 8 (wire analyzer).

---

## Step 7 — Migrate `DetailPanel` and `Sidebar` to `ModuleViewData`

`DetailPanel` currently receives `schemaByKind`, `capabilityByKind`, `resolvedResources` as separate props derived in `Editor.tsx`. `Sidebar` receives `availableKinds` as a separate array. Replace these with `viewData: ModuleViewData` and derive internally:

- `DetailPanel`: compute `schemaByKind`, `capabilityByKind`, `resolvedResources` from `viewData.kinds` + `viewData.manifest.resources`.
- `Sidebar`: compute `availableKinds` array from `[...viewData.kinds.values()]`. This now includes both imported and local kinds (unified), which means the "Create Resource" dropdown will show locally-defined kinds. This is the intended behavioral change — resolving the asymmetry where Sidebar previously only received imported kinds.

After this step, the legacy derivation block in `Editor.tsx` (added in step 3 as a bridge) is removed. `Editor.tsx` passes `viewData` to all consumers uniformly.

---

## Step 8 — Wire analyzer to populate `diagnosticsByResource`

The analyzer's `StaticAnalyzer.analyze()` accepts `ResourceManifest[]` and returns a flat `AnalysisDiagnostic[]`. The editor stores manifests as `ParsedManifest`. Bridging this gap requires several substeps.

### 8a — Manifest conversion: `ParsedManifest` → `ResourceManifest[]`

The existing `toManifestDocs()` in `loader.ts:670-701` handles user resources correctly (spreads `resource.fields` to top level, constructs `metadata: { name }`). However, **two kinds of data are lost during the original `buildParsedManifest` parse** and `toManifestDocs` cannot reconstruct them:

1. **`Telo.Module` is missing `variables` and `secrets` schemas.** `buildParsedManifest` (loader.ts:450-462) stores only `{ name, version?, description? }` in `ParsedManifest.metadata`. The module's `variables`/`secrets` schema maps are dropped. The analyzer's `buildKernelGlobalsSchema` (kernel-globals.ts:53) reads `moduleManifest?.variables` to type-check CEL expressions like `${{ variables.port }}`. Without it, CEL validation produces false results.

2. **`Telo.Import` is missing `resolvedModuleName`, `resolvedNamespace`, and `exports.kinds`.** The analyzer reads these at analyzer.ts:279-287 to register import aliases and module identities. `ParsedImport` (model.ts:40-47) doesn't store any of these. Without them, the analyzer falls back to deriving the module name from the source path, which may not match the actual module name, causing false `UNDEFINED_KIND` errors.

**Fix:** Enrich the editor's model to preserve these fields during initial parsing:

- Extend `ParsedManifest.metadata` with optional `variables?: Record<string, unknown>` and `secrets?: Record<string, unknown>`.
- Extend `ParsedImport` with optional `resolvedModuleName?: string`, `resolvedNamespace?: string | null`, and `exportedKinds?: string[]`.
- Update `buildParsedManifest` to capture these from the raw `ResourceManifest`.
- Update `toManifestDocs` to emit them back.

This model enrichment is a prerequisite for step 8b. It doesn't affect steps 1-7 (the fields are optional and existing code ignores them).

To build the full analysis input: iterate all `ParsedManifest` entries in `application.modules` and call the enriched `toManifestDocs()` for each, concatenating the results.

### 8b — Analysis runner

Create `src/analysis.ts` with:

```ts
function analyzeApplication(application: Application): Map<string, Map<string, AnalysisDiagnostic[]>>
```

- Converts the application to `ResourceManifest[]` (from 8a).
- Calls `StaticAnalyzer.analyze()`. The analyzer auto-creates fresh `AliasResolver` and `DefinitionRegistry` internally when no `AnalysisRegistry` is passed. For incremental analysis (re-use across edits), create one `AnalysisRegistry` per application load (stored in a ref in `Editor.tsx`), pass it to `analyze()`, and reset it on full reload. `AnalysisRegistry` auto-seeds with `KERNEL_BUILTINS` in its `DefinitionRegistry` constructor — no manual seeding needed.
- Groups the flat diagnostic array into the nested `Map<filePath, Map<resourceKey, AnalysisDiagnostic[]>>` structure. **Grouping requires a reverse lookup**: the diagnostic `data` field carries `{ resource: { kind, name } }` but no filePath. Build a `Map<string, string>` from `{kind}/{name}` → filePath by iterating `Application.modules` before grouping.

### 8c — Invocation points in `Editor.tsx`

Call `analyzeApplication` and update `diagnosticsByResource` in state:

- After `loadApplication` completes (initial load).
- After `handleCreateResource`, `handleUpdateResource`, `handleRemoveImport`, `handleAddImport`, `handleAddModule`, `handleUpgradeImport` (any mutation).
- Debounce re-analysis on rapid edits (e.g., 300ms after last mutation) to avoid blocking the UI on every keystroke in the detail panel.

**Performance:** `StaticAnalyzer.analyze()` does schema validation, CEL parsing, reference resolution, and dependency graph construction. For small manifests this is fast, but for large applications it can block the main thread. Run analysis in a **web worker** to keep the UI responsive. The analyzer is browser-compatible (no DOM/Node APIs). If a worker is too complex for the initial implementation, use `requestIdleCallback` as a simpler first step and migrate to a worker when manifests grow.

### 8d — Project diagnostics into `ModuleViewData`

`buildModuleViewData` already accepts `moduleDiagnostics` (from step 3) and maps it into `ModuleViewData.diagnostics`. Once step 8c populates the state, diagnostics flow through automatically.

After this step, diagnostic icons in inventory (from step 6) light up with real data.

---

## Step 8.5 — Source view (move YAML state panel into views)

Move the existing `YamlStateViewer` from a side panel into the view system as a "Source" view.

### What changes

1. **Add `"source"` to `ViewId`** in `model.ts`. Update `VALID_VIEWS` in `storage.ts`.

2. **Create `src/components/views/source/SourceView.tsx`**. Accepts `ViewProps`. Renders the YAML representation of the active module's manifest using `renderManifestYaml(viewData.manifest)` from `loader.ts`. Uses Monaco editor (read-only) — same as the current `YamlStateViewer` but scoped to the active module.

   For multi-file modules (where resources have `sourceFile` set), use `getMultiFileSnapshots(viewData.manifest)` from `loader.ts` and render tabs per file, matching the current behavior within the active module.

3. **Register in `ViewContainer`** — add `{ id: "source", label: "Source" }` to `VIEW_TABS` and render `<SourceView />` when active.

4. **Remove `<YamlStateViewer />` from `Editor.tsx`** — it's replaced by the Source view. Remove the `yamlSnapshots` derivation (`getYamlStateSnapshots` call). Remove the `YamlStateViewer` import.

5. **Delete `src/components/YamlStateViewer.tsx`** — no longer needed.

### Scoping difference

The current `YamlStateViewer` shows all modules (tabs per file across the entire application). The Source view shows only the active module. This is consistent with the other views (all single-module scoped). Other modules are reachable via breadcrumb navigation.

### No contract changes

`ViewProps` and `ModuleViewData` are unchanged. The Source view derives YAML from `viewData.manifest` using existing `renderManifestYaml` / `getMultiFileSnapshots` functions.

---

## Step 9 — Workflow view

Add `"workflow"` to the `ViewId` union. Register in `ViewContainer`. Zero changes to `ViewContainer`'s or `Editor`'s interfaces — the view is fully self-contained.

**New dependencies:** `elkjs` (~1MB, MIT license, browser-compatible WASM layout engine) and `@xyflow/react` (React Flow, MIT license, graph canvas). Neither is in `package.json` currently — add them to `apps/telo-editor/package.json`.

Create `src/components/views/workflow/` with the following structure:

```
workflow/
  WorkflowView.tsx        ← top-level component, accepts ViewProps
  graph-builder.ts        ← derives nodes + edges from ModuleViewData
  layout.ts               ← auto-layout using elkjs
```

### 9a — Graph data model (`graph-builder.ts`)

Define the visual graph types:

```ts
interface GraphNode {
  id: string;                  // `${kind}/${name}`
  resource: ParsedResource;
  resolvedKind: AvailableKind | null;
  diagnostics: AnalysisDiagnostic[];
  scopeParent?: string;        // id of the scope-owning node, if this resource is scoped
}

interface GraphEdge {
  from: string;                // source node id
  to: string;                  // target node id
  fieldPath: string;           // e.g., "handler", "steps[].invoke"
  refConstraint: string[];     // allowed kinds from x-telo-ref
  isScoped: boolean;           // true if target lives in an x-telo-scope
}

interface ScopeGroup {
  id: string;                  // owning resource id
  scopePath: string;           // JSON pointer (e.g., "/steps")
  containedNodeIds: string[];  // resource ids inside this scope
}

interface WorkflowGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  scopes: ScopeGroup[];
}
```

Build the graph from `ModuleViewData`:

1. **Nodes**: one per resource in `viewData.manifest.resources`, excluding `Telo.Definition`, `Telo.Import`, and `Telo.Module` — these are structural metadata, not runtime resources. Enrich with `viewData.kinds.get(r.kind)` for capability/topology metadata and `viewData.diagnostics.get(r.name)` for diagnostic state.

2. **Edges**: for each resource, use the analyzer's `buildReferenceFieldMap()` on its kind's schema (from `viewData.kinds.get(r.kind).schema`) to discover all `x-telo-ref` field paths. Then resolve actual reference values from `resource.fields` using `resolveFieldValues()`. Each resolved reference that matches an existing resource produces an edge.

3. **Scopes**: for each kind schema with `x-telo-scope` annotations, identify which resources are declared inside scoped fields. Group them into `ScopeGroup` objects with the owning resource, scope path, and contained resource IDs.

**Prerequisite — analyzer public exports:** `buildReferenceFieldMap`, `resolveFieldValues`, `isRefEntry`, and `isScopeEntry` are currently internal to `@telorun/analyzer` (not in `index.ts`). They must be added to the analyzer's public exports before the workflow view can use them. This is a package-level change to `analyzer/nodejs/src/index.ts`.

**Limitation — CEL expression references:** Reference fields may contain CEL expressions (e.g., `${{ variables.handlerName }}`) instead of literal resource names. These are opaque strings at edit time — they haven't been evaluated. The workflow view cannot produce edges for them. Handle this by: when a reference value is a string containing `${{ }}`, render a dashed "dynamic reference" placeholder edge with a `${{ }}` label instead of a resolved target. This makes the dynamic reference visible without pretending it's resolved.

### 9b — Auto-layout (`layout.ts`)

Use `elkjs` (ELK layered algorithm, browser-compatible, no DOM dependency) to compute node positions:

- Topological order from `buildDependencyGraph()` hints at layer assignment.
- `ScopeGroup` entries become compound nodes (ELK supports hierarchical graphs natively), with contained resources rendered inside the scope container.
- Scoped edges get different routing (inside the scope container).
- Layout is recomputed when resources or references change.

### 9c — WorkflowView component

Accepts `ViewProps`. Internally:

1. Calls `buildWorkflowGraph(viewData)` to derive the graph.
2. Calls the layout engine to position nodes.
3. Renders with `@xyflow/react` (React Flow):
   - **Custom node component**: shows resource name, kind badge, capability icon, diagnostic indicator. Highlighted when `selectedResource` matches. Amber highlight when `graphContext` matches.
   - **Custom edge component**: styled by type — solid for boot-time dependencies, dashed for scoped references. Label shows `fieldPath`.
   - **Scope containers**: rendered as group nodes in React Flow, with `ScopeGroup.containedNodeIds` laid out inside.
4. Click a node → `onSelectResource` (opens detail panel).
5. Double-click / button on a topology-aware node → `onNavigateResource` (switches to topology view).
6. Diagnostics: nodes with issues show the same warning icon/border as inventory.

### 9d — Edge filtering

The workflow view should support filtering edges by category:

- **All references** — every resolved `x-telo-ref` edge.
- **Boot-time only** — exclude scoped edges (matches the analyzer's `buildDependencyGraph` output). Shows the initialization order.
- **By capability** — e.g., show only `Telo.Invocable` edges to trace the invocation graph.

This is a local UI control (dropdown/toggle) inside the workflow view — not part of `ViewProps`.

---

## Step 10 — Cross-module view data for workflow

Extend `ModuleViewData` with an optional cross-module graph:

```ts
interface ImportEdge {
  fromModule: string;   // filePath of importing module
  toModule: string;     // filePath of imported module
  alias: string;        // PascalCase import alias
  exportedKinds: string[];
}

interface ModuleViewData {
  // ... existing fields ...
  importEdges?: ImportEdge[];
}
```

`buildModuleViewData` derives `importEdges` from `Application.importGraph` + `ParsedManifest.imports`. This keeps the `Application` object out of `ViewProps` — views access cross-module data through the curated `ModuleViewData` contract, not the raw `Application` graph.

When present, the workflow view adds:

- **Import nodes**: collapsed group nodes representing imported modules. Shows module name and version.
- **Cross-module edge resolution**: when a reference target (resource name) is not found among local nodes, match the kind prefix against `importEdges[].alias`. If matched, route the edge to the corresponding import group node instead of dropping it. This bridges the gap between resource-level references and module-level import edges.
- **Edge styling**: cross-module edges are styled distinctly from intra-module edges (e.g., different color or dash pattern).

Additive change to `ModuleViewData`. Existing views ignore the field.
