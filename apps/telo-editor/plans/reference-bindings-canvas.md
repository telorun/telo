# Resource Canvas — Implementation Plan

Goal: every resource opens in a canvas. The generic canvas is a two-pane view — form on the left, visual bindings on the right — aligned so each ref-bearing field's binding sits next to its form row. Specialized canvases (`Router`, `Sequence`) remain; they replace the generic canvas for their kinds.

## Motivation

Today, selecting a resource like `http-server.Server` in the sidebar opens the DetailPanel but shows "does not have a canvas renderer yet" on the main canvas — the empty center is a UX wart. Wiring refs (mounts, not-found handler, parsers) requires dropping into the YAML. And [ARCHITECTURE.md:30](apps/telo-editor/ARCHITECTURE.md#L30)'s "topology is required for navigation" rule means the main canvas can never fill in for topology-less kinds.

The unifying primitive across HTTP mounts, MCP tools, agent tools, not-found handlers, content-type parsers, and any future host is **binding an `x-telo-ref` to a target**. A generic canvas that pairs the form with per-field binding widgets handles all of them in one view — schema-driven, no kind hardcoding.

## Design

### Canvas selection (new rule)

Every resource is navigable. `TopologyView` picks the renderer from the kind's `topology`:

1. `topology === "Router"` → `RouterTopologyCanvas` (unchanged, full-canvas)
2. `topology === "Sequence"` → `SequenceTopologyCanvas` (unchanged, full-canvas)
3. else → `ResourceCanvas` (new, the generic form + bindings view)

The existing "topology is required for navigation" rule in [ARCHITECTURE.md:30](apps/telo-editor/ARCHITECTURE.md#L30) goes away. Every kind produces a canvas.

### ResourceCanvas layout

Two panes, row-aligned by schema property order:

```text
┌─ form ──────────────────┬─ bindings ──────────────────────┐
│ host         [localhost]│                                 │
│ port         [8080]     │                                 │
│ mounts                  │ [/api]──────────[Api:users]     │
│                         │ [/admin]────────[Api:admin]     │
│                         │ [+ add]                         │
│ notFoundHandler         │ [set handler…]  [Invocable:404] │
│ contentTypeParsers      │ [application/…]─[Invocable:…]  │
│                         │ [+ add]                         │
└─────────────────────────┴─────────────────────────────────┘
```

- The form pane reuses `ResourceSchemaForm`.
- The bindings pane renders a widget per top-level `x-telo-ref` field, vertically aligned with that field's form row.
- Fields without refs leave the right-side empty.
- Alignment strategy: both panes walk the same ordered list of top-level schema properties; each field renders as a row with fixed-slot left + right columns. A shared row container owns the height.

### Bindings pane shapes

Picked from field structure alone:

| Field shape                                          | Binding widget                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| scalar `x-telo-ref`                                  | single chip + "set" picker; empty state shows "set handler…"           |
| array with `items.x-telo-ref`                        | horizontal chip list + "add" button                                    |
| array of objects with exactly one `x-telo-ref` child | cards stacked — key label on left, target picker on right, "add" row   |

For "array of objects", the key label is the first sibling string field (by schema order). If no string sibling exists, the card has no key label and the target chip is the card's sole content. Remaining non-ref siblings are not rendered in the binding card — they live in the form pane as they do today.

### Schema walk depth

**Top-level only.** Sections surface for refs at the root of the schema, or one level deep inside top-level array items (array-of-refs and array-of-objects-with-a-ref). Deeply nested refs are not surfaced. `oneOf` / `anyOf` at either level are walked like `collectRefTargets` already does in [reference-select-field.tsx:67](apps/telo-editor/src/components/resource-schema-form/reference-select-field.tsx#L67).

### DetailPanel becomes recursive

The right-hand DetailPanel stops being a form duplicate. Instead, when a resource chip in the main canvas's bindings pane is clicked (or a sub-resource reference is selected elsewhere), the DetailPanel renders the **same `ResourceCanvas`** for that sub-resource. Drill-down without losing context.

**Peek, not navigate.** The main canvas is the pinned context; the panel is the peek target. Clicking a chip *inside* the panel replaces the panel's contents with the newly peeked resource — the main canvas does not change. Peeking chains as deep as the user wants without touching the main context.

The panel header carries an explicit **"Open in canvas"** button that promotes the current peek target to `graphContext` (swaps the main canvas). This is the only path from peek to navigation. Wire the button to the existing `onNavigateResource(kind, name)` callback from [types.ts:10](apps/telo-editor/src/components/views/types.ts#L10) — no new callback needed; the sidebar and inventory view already use it with the same semantics.

Single-level for now: panel shows the most recent sub-selection, no navigation stack. `selectedResource` is cleared when the active module changes — mirroring how `graphContext` is cleared at [Editor.tsx:213](apps/telo-editor/src/components/Editor.tsx#L213) — so peeking is always relative to the current main canvas.

### Constraints

- **Topology-driven.** The canvas must not know about `http-server`, `Telo.Mount`, agents, etc. Everything comes from `x-telo-ref` capabilities + schema structure.
- **Browser-safe.** No new Node.js imports in `apps/telo-editor` or `analyzer/nodejs`.
- **Router & Sequence untouched.**

---

## Step 0 — Analyzer-backed capability resolution

`DefinitionRegistry.getByExtends(abstractKind)` at [definition-registry.ts:151](analyzer/nodejs/src/definition-registry.ts#L151) already does transitive capability lookup — do **not** add a parallel `getByCapability`. The stale doc references in [ARCHITECTURE.md:301,374](apps/telo-editor/ARCHITECTURE.md#L301) to `registry.getByCapability()` are fixed in Step 7.

What the editor needs:

1. Resolve each `x-telo-ref` string (e.g. `"telo#Mount"`) to its canonical kind via the existing `registry.resolveRef`.
2. Enumerate candidate definitions via `registry.getByExtends(resolvedKind)`.
3. Intersect with in-scope resources from `viewData.manifest.resources`.

Lift this into a shared helper that accepts a **list** of ref targets (matching `BindingDescriptor.refCapabilities: string[]` from Step 3) and unions the candidates across alternatives:

```ts
function resolveRefCandidates(
  refTargets: string[],
  registry: DefinitionRegistry,
  resources: ParsedResource[],
): ResolvedResourceOption[]
```

Single source of truth for "what can fill this slot", consumed by Step 1's stale-check fix and the new bindings pane. Call sites with a single ref pass a length-1 array.

---

## Step 1 — Fix stale `kernel` scope check

Cleanup that lands on top of Step 0's helper. After the Kernel→Telo rename, `parseRefTarget("telo#Mount").scope` is `"telo"` (lowercased). The capability branch at [reference-select-field.tsx:57](apps/telo-editor/src/components/resource-schema-form/reference-select-field.tsx#L57) and [array-object-field.tsx:52](apps/telo-editor/src/components/resource-schema-form/array-object-field.tsx#L52) still checks `scope === "kernel"` and is dead — abstract-capability refs currently fall through to a fuzzy `endsWith` match.

Replace both call sites with `resolveRefCandidates` from Step 0. Removes a latent bug and aligns the existing form-view picker with the new bindings pane.

---

## Step 2 — Add `x-telo-ref` to `notFoundHandler`

In [modules/http-server/telo.yaml:199-249](modules/http-server/telo.yaml#L199-L249), the `invoke` sub-object has a raw `kind: string` with no `x-telo-ref`. Add:

```yaml
notFoundHandler:
  type: object
  properties:
    invoke:
      x-telo-ref: "telo#Invocable"
      oneOf:
        - type: "string"
        - type: "object"
          properties:
            kind: { type: "string" }
          required: ["kind"]
          additionalProperties: true
```

Matches the pattern already used by `contentTypeParsers[].parser`. Without this, `notFoundHandler` would not surface in the bindings pane.

---

## Step 3 — Binding discovery helper

New pure helper in `apps/telo-editor/src/components/views/topology/bindings.ts`:

```ts
interface BindingDescriptor {
  fieldPath: string;                               // top-level field name
  title: string;                                   // schema.title ?? fieldPath
  description?: string;
  shape: "scalar" | "array-of-refs" | "array-of-objects";
  refCapabilities: string[];                       // e.g. ["telo#Mount"]; >1 when oneOf/anyOf
  keyFieldName?: string;                           // array-of-objects only
}

function discoverBindings(schema: Record<string, unknown>): BindingDescriptor[]
```

Rules:

- Walk `schema.properties` once (top-level only).
- Scalar: property has `x-telo-ref` **or** `oneOf`/`anyOf` alternatives carrying `x-telo-ref` → `shape: "scalar"`, `refCapabilities` from all alternatives.
- Array-of-refs: `type: array` with `items.x-telo-ref` (or items with `oneOf`/`anyOf` refs) → `shape: "array-of-refs"`.
- Array-of-objects: `type: array` with `items.type: object` and exactly one object-property carrying an `x-telo-ref` → `shape: "array-of-objects"`. `keyFieldName` = first string-typed sibling in schema order (if any).
- Items with multiple refs or objects nested deeper than one level are skipped (still editable via the form pane).

Pure, unit-testable. Tests cover each shape including `oneOf` ref discovery.

---

## Step 4 — `ResourceCanvas` component

New component `apps/telo-editor/src/components/views/resource-canvas/ResourceCanvas.tsx`.

Props: same hand-rolled subset currently used by `RouterTopologyCanvas` (`resource`, `schema`, `onUpdateResource`, `onSelect`, `onBackgroundClick`) — not the full `ViewProps`.

Responsibilities:

- Render a row-aligned two-column layout over the top-level schema properties.
- Left column: one `ResourceSchemaForm` row per property (reuse the existing form row renderer; do not duplicate).
- Right column: for each property returned by `discoverBindings(schema)`, render the matching widget (`ScalarBindingSlot`, `RefChipList`, `ObjectBindingCards`). Non-bound properties leave the right column empty.
- Target picker uses `resolveRefCandidates` from Step 0.
- All edits propagate through `onUpdateResource`.
- Clicking a target chip fires `onSelectResource` (peek into DetailPanel). Never `onNavigateResource` — promotion to main canvas is the explicit panel-header button (Step 6).

No drag-and-drop, no reordering in this step.

---

## Step 5 — Always-navigable selection

In [Editor.tsx](apps/telo-editor/src/components/Editor.tsx) (and wherever the sidebar triggers selection), drop the "has topology → set graphContext" gating. Every resource selection updates `graphContext` so the main canvas renders something.

Update `TopologyView` to route:

```tsx
if (topology === "Router")   return <RouterTopologyCanvas … />
if (topology === "Sequence") return <SequenceTopologyCanvas … />
return <ResourceCanvas … />;
```

Kill the "does not have a canvas renderer yet" branch.

---

## Step 6 — DetailPanel → recursive `ResourceCanvas`

Strip the form-duplicating guts of [DetailPanel.tsx](apps/telo-editor/src/components/DetailPanel.tsx). Replace with a wrapper that renders `ResourceCanvas` for `selectedResource` (the current sub-selection), distinct from `graphContext` (the main canvas resource).

Selection model: clicking a chip in the main canvas's bindings pane sets `selectedResource` (not `graphContext`). The DetailPanel shows that sub-resource. A "promote" affordance (e.g. double-click or a button on the panel) swaps `selectedResource` into `graphContext`.

**State-model divergence — call out during build.** [types.ts:7-10](apps/telo-editor/src/components/views/types.ts#L7-L10) already declares `selectedResource`, `graphContext`, `onSelectResource`, and `onNavigateResource`, but the selection handlers in [Editor.tsx](apps/telo-editor/src/components/Editor.tsx) currently update both contexts together (see the `graphContext: { kind, name }` write at [Editor.tsx:342](apps/telo-editor/src/components/Editor.tsx#L342) whenever selection changes). This step decouples them cleanly:

- `onSelectResource(kind, name)` → updates `selectedResource` only (peek).
- `onNavigateResource(kind, name)` → updates `graphContext` (main canvas swap). Already used by sidebar and inventory view with these semantics.
- Bindings-pane chip click → `onSelectResource` (peek into panel).
- Panel header "Open in canvas" button → `onNavigateResource` (promote).
- Sidebar click → `onNavigateResource` (as today).

Audit every `graphContext: …` write and selection callback in `Editor.tsx` during this step; the split is mechanical but touches multiple handlers.

If the form-state duplication becomes a problem, we'll re-visit the single-surface option in a follow-up.

---

## Step 7 — ARCHITECTURE.md reconciliation

Two edits in [apps/telo-editor/ARCHITECTURE.md](apps/telo-editor/ARCHITECTURE.md):

1. Retire the "topology is required for navigation" rule at line 30. Replace with: *"Every resource is navigable. The renderer used for the canvas is chosen from the kind's `topology`; kinds without a topology render in the generic `ResourceCanvas` (form + bindings)."*
2. Reconcile §4 "Connectable mode" (lines ~297-335). The bindings pane **is** the realization of connectable mode for resource editing. Rewrite §4 to describe the bindings pane as the mechanism for every kind *except* workflow topology — the React-Flow graph canvas with edges is retained **only** as the planned renderer for a future `topology: Workflow` and does not apply to general resource display. Fix the stale `registry.getByCapability()` references — the registry method is `getByExtends`.

---

## Smoke test

On `modules/http-server`'s `Server`, after Step 2's schema change, `ResourceCanvas` renders:

- **host / port / baseUrl / logger / openapi / cors** — form rows only (no bindings).
- **mounts** — form row + bindings pane column showing cards: `[path] [Api:…]` with "add".
- **contentTypeParsers** — form row + cards: `[contentType] [Invocable:…]` with "add".
- **notFoundHandler** — form row + scalar slot: `[set handler…]` / `[Invocable:…]`.

Every existing `Server` field remains editable via the form pane; nothing regresses.

On a `Telo.Definition` router like `pipeline.Router` (topology: Router), `RouterTopologyCanvas` still renders as today.

## Non-goals for this round

- Drag-and-drop reordering of slots.
- Visual edges / graph rendering between resources.
- Folding `Router`/`Sequence` into the generic canvas.
- Multi-level DetailPanel navigation stack.
- Deep (>1 level) ref discovery.
- Module-wide topology view.
