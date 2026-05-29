# Resource Graph Canvas — Implementation Plan

## Problem

The Topology tab is per-resource: pick a resource in the sidebar and you see its
Sequence/Router/bindings canvas; with nothing focused it shows a "Select a resource"
empty state ([TopologyView.tsx:49-58](../src/components/views/topology/TopologyView.tsx#L49-L58)).
There is no module-level overview — you cannot see at a glance what resources a module
contains or how they connect. A module-wide graph with visual edges was explicitly
deferred as a non-goal in [reference-bindings-canvas.md:241-248](reference-bindings-canvas.md#L241-L248);
this plan delivers that deferred piece.

## Solution

A node graph (`@xyflow/react`) becomes the Topology tab's **landing view**, replacing the
empty state. The split is driven by the existing `graphContext` state: when it is `null`,
render the module graph; when set, render the existing per-resource `PickCanvas`. Selecting
a node peeks into the right pane ([DetailPanel.tsx](../src/components/DetailPanel.tsx)) via
the existing `onSelectResource`; an "Open in canvas" action sets `graphContext`
(`onNavigateResource`) to drill in; a "Back to overview" affordance clears it. This reuses the
existing peek/navigate/DetailPanel machinery wholesale — no new view tab.

**Nodes** are resources partitioned by capability (from `viewData.kinds.get(kind).capability`,
never by kind name): the Application root plus Service, Invocable, Runnable, and Mount. The
Application root is not a `manifest.resources` entry, so the selection model gains an
"application" variant; DetailPanel renders the root's targets and variables/secrets in the
reused pane shell with new body content. Providers and Types render in a **collapsible side
strip** on the canvas, not as nodes.

**Edges** are derived generically: every node-to-node `x-telo-ref` becomes an edge, labeled
by the originating field/role, discovered with the same analyzer ref-walking the bindings
canvas already uses ([ref-candidates.ts](../src/components/resource-schema-form/ref-candidates.ts),
`registry.getByExtends`). Application→target references add their own edges. No resource kind is
hardcoded — the graph is fully topology-driven.

**Layout** is deterministic auto-layout via `@dagrejs/dagre`, recomputed each render from the
resource set and edges. Node positions never enter the YAML (manifests stay the source of truth)
and are not persisted; the layout is a pure projection of the manifest.

New code lives under `apps/telo-editor/src/components/views/topology/` (the graph canvas,
its node/edge builders, and the providers side strip), plus an "application" branch in
DetailPanel and a small selection-variant change in `Editor.tsx`/`model.ts`. `@xyflow/react`
and `@dagrejs/dagre` are added to the editor's `package.json` (a changeset accompanies the
package change).

## Decisions

- **Graph is the Topology landing view, not a new tab** — reuses `graphContext` null/set as the overview/detail switch and the existing peek→navigate flow; a 5th tab would duplicate selection plumbing and split the mental model.
- **Node-vs-strip partition is capability-driven** — Application/Service/Invocable/Runnable/Mount are nodes; Provider/Type are ambient value/schema sources with no meaningful position in a connection graph, so they live in the side strip. Keys off capability, never kind, per the topology-driven constraint.
- **All node-to-node `x-telo-ref`s are edges** (not just invoke) — a single generic rule keeps the analyzer as the one source of connection truth and avoids per-role special-casing; edges are labeled by field so invoke/mount/handler stay legible.
- **Deterministic auto-layout, no persisted positions** — `@dagrejs/dagre` over draggable+localStorage; YAML is the source of truth and view-only x/y has no home there. Rejected elkjs as heavier/worker-based for no benefit at this graph size.
- **Application selection variant** — the root has no `{kind,name}` resource entry, so the selection model carries an explicit "application" case rather than faking a pseudo-resource.
- **Read-only v1** — navigation and selection only; drag-to-wire edge creation is deferred. Wiring already exists in the bindings canvas/forms, so duplicating it now adds risk without new capability.
- **Application pane: targets editable, variables/secrets read-only** — targets are references to runnable nodes and belong in the visual surface; variables/secrets are JSON-Schema declarations edited in Source.
- **Active module only** — imported modules' resources are out of scope for v1; the graph shows one module's own resources.
