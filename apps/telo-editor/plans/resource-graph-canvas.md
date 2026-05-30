# Resource Graph Canvas — Implementation Plan

> **Status: implemented.** The Application overview graph ships as the
> `topology: "Application"` canvas
> ([ApplicationTopologyCanvas.tsx](../src/components/views/topology/ApplicationTopologyCanvas.tsx)),
> fed by the synthesized-kind adapter
> ([application-adapter.ts](../src/application-adapter.ts)) and the
> [application-canvas-model.ts](../src/components/views/topology/application-canvas-model.ts)
> projection over the analyzer's `buildOverviewGraph`. Drag-to-wire target
> editing writes through `setApplicationTargets` (a manifest-root AST op). This
> document describes the design as built.

## Problem

The Topology tab is per-resource: pick a resource in the sidebar and you see its
Sequence/Router/bindings canvas; with nothing focused it shows a "Select a resource"
empty state ([TopologyView.tsx:49-58](../src/components/views/topology/TopologyView.tsx#L49-L58)).
There is no module-level overview — you cannot see at a glance what resources a module
contains or how they connect. A module-wide graph with visual edges was explicitly
deferred as a non-goal in [reference-bindings-canvas.md:241-248](reference-bindings-canvas.md#L241-L248);
this plan delivers that deferred piece.

## Solution

**The graph is `Telo.Application`'s topology canvas.** The Application becomes a
selectable resource like any other; PickCanvas dispatches its renderer the same way it
dispatches Router or Sequence — by the kind's `topology` field. A new topology value
`"Application"` on `Telo.Application` resolves to the new graph renderer
(`ApplicationTopologyCanvas`). Opening a module default-selects the Application, so the
natural landing view of the Topology tab is the graph; the existing "Select a resource"
empty state is reached only by deselecting, not by default. Selecting a node inside the
graph peeks into the right pane ([DetailPanel.tsx](../src/components/DetailPanel.tsx)) via
the existing `onSelectResource`; "Open in canvas" (`onNavigateResource`) sets
`graphContext` to drill into the selected resource's own canvas; navigating back to the
Application returns to the graph. This reuses the existing peek/navigate/DetailPanel and
PickCanvas dispatch as-is — no new view tab, no "overview mode" carve-out in
`TopologyView`, no `graphContext === null` special branch.

**Nodes** are resources partitioned by capability (from `viewData.kinds.get(kind).capability`,
never by kind name): Application + Service + Invocable + Runnable + Mount. The Application
appears as the canvas's root node — a mild recursion (the root of the canvas appears
within it) of the same shape filesystem trees and git repos use. Clicking the Application
node peeks at its targets / variables / secrets in DetailPanel, which gains new body
content for those fields. Providers and Types render in a **collapsible side strip** on
the canvas, not as nodes.

**Sequence-like nodes render their internal step topology.** A node whose kind schema
declares an `x-telo-topology-role: steps` field (e.g. `Run.Sequence`) shows its steps as
sub-rows inside the node, each with its own source handle. Discovery recurses through every
branch (`do` / `then` / `else`), case map, and branch list (`elseif`), flattening the tree
into an ordered, depth-indented row list — so the real invokes inside a `while/do` loop are
shown individually rather than collapsed onto the loop. Each row keeps its full concrete
path (`steps[1].do[3]`); an edge anchors to the **deepest** step its ref `fromPath` falls
under, so every `steps[].invoke` gets its own edge endpoint instead of bundling onto the
node's outer handle. Step discovery is annotation-driven via the same `schema-utils` variant
helpers the per-resource Sequence canvas uses (`getVariants` / `matchVariant` /
`invokeField` / branch roles), so no kind name is hardcoded; the model emits a pure `steps`
list (`{ path, name, detail, depth }`) per node and the renderer owns the xyflow handles
(with selector-safe handle ids). This is a single-list view: nested steps are indented
rather than drawn as recursive boxes. Since `@dagrejs/dagre` has no per-handle/port
ordering, a post-layout pass pulls each node's vertical center toward the handle it is
wired from — a step row for a per-step invoke edge, otherwise the source node's center —
averaging when several edges feed one node and keeping dagre's y when none do. Ranks are
swept left-to-right so a downstream node follows its source's *already-aligned* y (keeping,
e.g., a model referenced by a stream step's target beside the node that links it); per rank
the nodes are ordered on that desired y, pushed apart with a min gap, then re-centered on
the desired centroid — so edges run roughly horizontal instead of crossing.

**Viewport is per-module.** The overview canvas's pan/zoom is keyed by module `filePath` in
`Editor` state (`viewportByModule`), captured on `onMoveEnd` via `onCanvasViewportChange` and
threaded back as `canvasViewport`. The `<ReactFlow>` is keyed by the module `filePath` so it
re-initializes per app/lib — restoring the saved viewport (`defaultViewport`, `fitView`
disabled) when one exists, fitting on first view otherwise; editing within a module keeps the
key stable so the viewport doesn't jump. The store is in-memory only (not persisted across
reloads), but lives in reducer state so it can be persisted later alongside
`activeModulePath` / `activeView`.

**Selected node highlight + delete.** The node matching the active `selectedResource`
(the same selection the DetailPanel peek uses) renders with a highlight ring — driven from
app state rather than React Flow's internal selection, since the canvas passes `nodes`
without an `onNodesChange` handler. Pressing Delete / Backspace while a non-root node is
selected removes that resource via a new `removeResourceViaAst` op (locates the declaring
file through `resourceDocIndex`, drops the doc, re-derives the manifest) wired through an
`onDeleteResource` callback; the key handler is scoped to the canvas and ignores presses
while a text input is focused. The Application/Library root is never deletable. Dangling
references left by a delete surface as normal analyzer diagnostics rather than being
auto-cleaned.

Because `Telo.Application` is a kernel built-in rather than a `Telo.Definition`, it has
no entry in `viewData.kinds` today and the manifest root isn't in `manifest.resources`.
A small adapter layer synthesizes both: an `AvailableKind` entry for `Telo.Application`
with `topology: "Application"` and a schema over metadata/targets/variables/secrets, plus
a `ParsedResource`-shaped view of the manifest root keyed by the module's name. Selection,
lookup, and PickCanvas dispatch then route through one path — "is it the application?"
checks don't get scattered across the codebase.

**Refs are rendered in two ways depending on the target's capability — a deliberate split,
not a universal rule.** Refs whose target is a canvas node (Service/Invocable/Runnable/Mount,
or the Application root for target refs) render as **labeled edges** between those nodes.
Refs whose target is an ambient value/schema source (Provider/Type) render as **"uses" chips**
on the source node, with the referenced provider/type also appearing in the side strip;
clicking a strip entry peeks at the provider/type in DetailPanel via the same
`onSelectResource` path as a node click. We accept the cost of two rendering subsystems
(edges-with-labels and chips+strip) in exchange for keeping the canvas readable as
control-flow/transport — ambient dependencies that don't carry control flow do not compete
visually with the ones that do. The alternative (every ref as an edge, including to
provider/type nodes) is honestly simpler to implement but muddies the canvas; the cost
trade-off is examined in the Decisions section.

Both rendering paths consume `visitManifest` — the analyzer's unified manifest visitor.
The visitor primitive, its discriminated-union event shape (`RefSite`, `CelSite`,
`SchemaFromSite`, `ScopeBoundary`, `ResourceEnter`/`Exit`), the refactor that subsumes
`validate-references`, `validate-cel-context`, and `buildDependencyGraph`, and the
editor-side `buildOverviewGraph` adapter that turns `RefSite` events into Edge/Chip
view models, are all owned by a **separate prerequisite plan** at
[analyzer/nodejs/plans/manifest-visitor.md](../../../analyzer/nodejs/plans/manifest-visitor.md).
That plan ships first; this plan consumes what it produces. The editor overview
subscribes to `RefSite` only. Form-level helpers like
[ref-candidates.ts](../src/components/resource-schema-form/ref-candidates.ts) answer "what
*could* fill this slot" and are not reused.

**Application↔target edges are the one editable surface in v1.** The Application root is
not a `ResourceManifest`, so it can't ride the visitor's iteration surface — the overview
reads `manifest.targets` directly and emits one edge per entry from the Application node
to the referenced runnable/service node. Targets are *also* the only field with no
existing alternative mutation path (they aren't `x-telo-ref` bindings, so the bindings
canvas and form pickers can't wire them). The graph fills that gap: dragging an edge from
the Application node to a Service or Runnable adds a target; deleting an edge removes one.
Endpoint validity is enforced at the canvas layer against the kernel rule that targets
must reference `Telo.Runnable` or `Telo.Service` — dragging to anything else is rejected
with a tooltip. Writes go through a new manifest-root AST op in `loader/ast-ops.ts` and a
new `onUpdateApplicationTargets` callback wired through `Editor.tsx`. No resource kind is
hardcoded — the partition is capability-driven and topology-driven.

**Layout** is deterministic auto-layout via `@dagrejs/dagre`, memoized over
(resources, edges) — recomputed only when those inputs change, not on every React render.
Node positions never enter the YAML (manifests stay the source of truth) and are not
persisted; the layout is a pure projection of the manifest.

**Two canvas stacks in the Topology tab, scoped by topology shape.** This plan introduces
`@xyflow/react` + `@dagrejs/dagre` for `topology: "Application"` while existing topology
renderers stay bespoke: `RouterTopologyCanvas` is hand-rolled HTML,
`SequenceTopologyCanvas` is `@dnd-kit`-based, `ResourceCanvas` is a two-pane form+bindings
layout. The split is by the topology's visualization shape, not by tab section. xyflow is
the renderer for genuine node-and-edge topologies — `"Application"` today, the
bindings-canvas plan already earmarks it for a future `"Workflow"` — and earns its weight
on those in pan/zoom/auto-layout/edge routing. Other topology shapes — a linear ordered
list (Sequence), a key→handler mapping that reads as a table (Router), a form aligned with
its bindings (ResourceCanvas) — aren't node-graphs and keep substrates that fit them;
forcing them onto xyflow would be heavier UX (drag-reorder-via-nodes is worse than
drag-reorder-via-rows) and heavier code for no win. The trajectory is by extension, not
retrofit: xyflow's footprint grows as new node-and-edge topologies arrive. The accepted
cost is two canvas technologies maintained side-by-side; "Open in canvas" crosses the
seam when drilling from the Application into a Router/Sequence/bindings resource, and
the surrounding chrome (header, peek pathway) stays consistent so only the canvas content
changes across it.

New code lives under `apps/telo-editor/src/components/views/topology/` (the
`ApplicationTopologyCanvas` renderer, node/edge builders, providers/types side strip, and
target drag-to-wire handler), a small adapter that synthesizes the `Telo.Application` kind
entry and a resource-shaped view of the manifest root, a new manifest-root targets AST op
in `loader/ast-ops.ts` with an `onUpdateApplicationTargets` callback through `Editor.tsx`,
and new Application body content in DetailPanel (read-only targets list / read-only
vars / read-only secrets, all with edit-in-Source for vars and secrets). Opening an
Application default-selects its overview graph (via `graphContext`). The graph now
replaces the sidebar's resource list entirely — the Sidebar's `ResourcesSection` is
removed and the create-resource action moves onto the canvas (an `onCreateResource`
panel button); the sidebar keeps only the workspace tree, imports, and definitions.
`@xyflow/react` and `@dagrejs/dagre` are added to the editor's `package.json` with
an accompanying editor changeset. The analyzer-side work (walker primitive and its consumer
refactors) lives in the prerequisite walker plan and ships separately.

## Decisions

- **Graph is `Telo.Application`'s topology canvas, not a special tab mode** — `Telo.Application` gets `topology: "Application"`; PickCanvas dispatches it the same way it dispatches Router or Sequence. No `graphContext === null` carve-out, no "overview mode" branch in `TopologyView`. Opening a module default-selects the Application so the graph is what you land on. Rejected alternatives: (a) **a 5th view tab** — duplicates selection plumbing and splits the mental model; (b) **"landing view when nothing is focused"** (the prior framing in this plan) — invents a special empty-state branch and a parallel rendering path, when the existing topology dispatch already does this naturally.
- **Node-vs-strip partition is capability-driven** — Application/Service/Invocable/Runnable/Mount are nodes; Provider/Type are ambient value/schema sources with no meaningful position in a connection graph, so they live in the side strip. Keys off capability, never kind, per the topology-driven constraint.
- **Refs split by target capability — edges for canvas nodes, chips+strip for ambient targets.** This is not a universal edge rule; it is a deliberate two-system rendering with stated cost. The canvas reads as control-flow/transport because ambient value/schema dependencies (Provider/Type) don't compete with it visually. Edges between canvas nodes are labeled by field so invoke/mount/handler stay legible; ambient refs surface as "uses" chips on the source node and entries in the strip; clicking a strip entry peeks at the provider/type in DetailPanel via the same path as a node click. Rejected alternatives: (a) **every ref is an edge, providers/types as visually-distinct nodes** — simpler but produces visual clutter on provider-heavy modules and reads ambient value flow as transport; (b) **promote on reference** — dual representation per provider, no real simplification over (a); (c) **bidirectional hover correlation between chips and strip entries** — polish, not core navigation; chips already carry the visual-clarity argument and the strip's selection→peek pathway already supports drill-in. The chip+strip subsystem cost (a side strip with its own selection→peek pathway and per-node chip rendering) is paid for the visual clarity it buys; the correlation layer is deferred.
- **Consumes `visitManifest` from the prerequisite manifest-visitor plan** — the analyzer-side primitive that supplies site events (`RefSite`, `CelSite`, `SchemaFromSite`, `ScopeBoundary`, resource enter/exit) to the editor's overview, the dependency graph, and reference + CEL validation is designed and shipped by [analyzer/nodejs/plans/manifest-visitor.md](../../../analyzer/nodejs/plans/manifest-visitor.md). The editor plan owns only the UI-layer consumer that turns `RefSite` events into Edge/Chip view models; the visitor plan owns the discriminated-union event shape, position threading for diagnostics, scope-boundary semantics, and the refactor of `validate-references` + `validate-cel-context` + `buildDependencyGraph` to consume the visitor. Rejected alternatives: (a) designing the visitor inline in this plan — couples two concerns (the visitor's generality and the editor's UI) into one diff and asserts generality by analogy rather than demonstrating it by subsumption; (b) a narrower refs-only walker — preserves the duplicated iteration scaffolding across CEL, schema-from, and scope handling that the visitor plan exists to remove.
- **Application↔target edges editor-side; targets edited via drag-to-wire on the graph** — the Application root is not a `ResourceManifest`, so it doesn't fit the visitor's iteration surface naturally; the overview reads `manifest.targets` directly. Drag-to-wire from the Application node to a Service/Runnable adds a target; edge deletion removes one. Endpoint validity is enforced at the canvas layer against the kernel rule (targets must be `Telo.Runnable` or `Telo.Service`). Writes go through a new manifest-root AST op and `onUpdateApplicationTargets` callback — distinct from the resource AST op path because targets live on the document root, not in `manifest.resources`. Rejected alternative: targets editable in the right pane via a synthesized resource shape — the synthetic-view is a read adapter and routing writes through it would silently never reach YAML.
- **Deterministic auto-layout, no persisted positions** — `@dagrejs/dagre` over draggable+localStorage; YAML is the source of truth and view-only x/y has no home there. Rejected elkjs as heavier/worker-based for no benefit at this graph size.
- **Synthetic kind entry + resource view for `Telo.Application`** — a small adapter exposes the kernel built-in to the editor's existing kind/resource pipelines: an `AvailableKind` for `Telo.Application` with `topology: "Application"` and a schema over metadata/targets/variables/secrets, plus a `ParsedResource`-shaped view of the manifest root keyed by the module name. Selection, lookup, and PickCanvas dispatch route through one path. Rejected alternative: scattering "is it the application?" checks across selection/lookup sites — produces a permanent special case at every selection boundary instead of one localized adapter.
- **Libraries reuse the same canvas** — a `Telo.Library` root is synthesized exactly like an Application (shared `module-root` adapter, shared `MODULE_OVERVIEW_TOPOLOGY` dispatch, shared renderer/model). The only differences are kind-data: a Library has no `targets`, so it gets no target edges and no drag-to-wire (`onTargetsChange` is withheld), and the detail body omits the Targets section. Resource nodes / strip / ref edges / create button are identical.
- **Read-only v1 except for target wiring** — navigation, selection, and *one* edit interaction: drag-to-wire on Application↔Runnable/Service edges. Other refs are not editable from the graph in v1 because `x-telo-ref` bindings already have wiring surfaces (bindings canvas / form pickers), so the graph duplicating them adds risk without new capability. Targets are the carve-out because they have *no* existing wiring surface — they aren't `x-telo-ref` bindings — so deferring them would leave v1 unable to edit targets at all. Rejected alternative: defer target wiring too and edit targets in Source — coherent but ships a graph that shows targets you can't manipulate, which reads as broken.
- **Application pane is fully read-only in v1** — targets shown as a read-only list (they're already visible and editable as edges); variables and secrets are JSON-Schema declarations edited in Source. Rejected alternative: editable targets in the pane — would need a write-back path through the synthetic resource view, which is purely a read adapter; editable-without-write-back is worse than read-only.
- **Active module only** — imported modules' resources are out of scope for v1; the graph shows one module's own resources.
