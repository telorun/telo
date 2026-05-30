---
"@telorun/editor": minor
---

Add the module overview graph as the `Telo.Application` topology canvas. Opening
an Application now lands on a node-and-edge graph of its resources: nodes are
partitioned by capability (Application / Service / Invocable / Runnable / Mount),
ref relationships render as labelled edges, and ambient Provider / Type sources
render as a collapsible side strip with "uses" chips on the resources that
reference them. Layout is deterministic via `@dagrejs/dagre`; rendering via
`@xyflow/react`.

The module root is exposed through a synthesized kind + resource adapter, so
selection, lookup, and the PickCanvas topology dispatch route it through the same
path as every other resource. Opening a module default-selects its overview
graph; the detail panel shows a read-only root summary (targets / variables /
secrets). The graph replaces the sidebar's resource list — the sidebar's
resources section is removed and the create-resource action moves onto the canvas
as a panel button.

`Telo.Library` modules get the exact same overview canvas (shared adapter,
topology dispatch, renderer, and model). A Library has no `targets`, so it gets
no target edges, no drag-to-wire, and no Targets section in the detail body;
everything else — resource nodes, Provider/Type strip, ref edges, create
button — is identical.

Edges and chips are derived from the analyzer's `buildOverviewGraph` /
`visitManifest`, so no resource kind is hardcoded in the editor. Refs nested
inside step bodies (e.g. `Run.Sequence` `steps[].invoke`) are surfaced via the
visitor's `discoverNestedRefs` value-tree scan, so resources used only from
inside a sequence no longer render detached.

Sequence-like nodes render their internal topology: a node whose kind schema
declares an `x-telo-topology-role: steps` field shows its steps as sub-rows, each
with its own source handle. Discovery recurses through branch / case / loop
bodies and flattens them into a depth-indented row list, so the invokes inside a
`while/do` loop appear individually instead of collapsed onto the loop. Each edge
anchors to the deepest step its ref `fromPath` falls under — so a multi-step
`Run.Sequence` shows one edge per `steps[].invoke` instead of bundling onto the
node's outer handle. Step discovery is annotation-driven (shared with the
Sequence canvas's variant helpers), so no kind name is hardcoded. A post-layout
pass aligns each node's vertical center with the handle it is wired from — a step
row for a per-step invoke edge, otherwise the source node — sweeping ranks
left-to-right so a downstream ref target follows its already-aligned source
(dagre has no per-handle ordering). Edges run roughly horizontal instead of
crossing.

The overview canvas's pan/zoom is remembered per module: the viewport is keyed by
module filePath in editor state and restored when navigating back to an app/lib
(fitting only on first view), instead of being shared across all modules.

The selected node is highlighted on the overview canvas, and pressing Delete /
Backspace on a selected non-root node removes that resource (new
`removeResourceViaAst` AST op). The module root is never deletable, and the key
handler is ignored while a text input is focused.

Targets are editable directly on the graph: dragging an edge from the
Application node to a Runnable / Service adds a target, deleting a target edge
removes one. Endpoint validity is enforced against the kernel rule (targets must
be `Telo.Runnable` or `Telo.Service`). Targets are read and written as `!ref
<name>` sentinels — the canonical reference form; the graph normalizes the
sentinel shape when matching edges. Writes go through a new manifest-root
`setApplicationTargets` AST op — distinct from the resource AST path because the
Application root lives on the document root, not in `manifest.resources`.
