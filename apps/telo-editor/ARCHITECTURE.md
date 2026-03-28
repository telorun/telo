# Telo Editor — Architecture

## Overview

The Telo Editor is a visual tool for authoring and navigating Telo manifest files. A manifest is a multi-document YAML file where each `---`-separated document is a **resource** with a `kind` and `metadata.name`. Resources reference each other by name, forming a directed graph within a module.

The editor works with an **Application** — a root module and all the submodules it transitively imports via local file paths. The application is the unit of authoring: you open a root module and the editor discovers and loads all connected submodules automatically.

The editor operates as a **three-panel layout**:

- **Left sidebar** — four sections: Imports, Flow resource tree, Definitions, and Library
- **Center canvas** — host for purpose-built sub-editors; content depends on the active paradigm
- **Right detail panel** — field editor for the currently selected resource, with drill-down into nested collections

### Paradigm-based sub-editors

The center canvas is not a single fixed view. It hosts a set of purpose-built sub-editors, each optimized for a specific resource paradigm and its natural topology. Navigating to a resource activates the sub-editor that matches its paradigm.

| Paradigm      | Topology                             | Sub-editor          | Activated by                |
| ------------- | ------------------------------------ | ------------------- | --------------------------- |
| Service graph | Connected resources, reference edges | React Flow canvas   | `Kernel.Runnable` (default) |
| Routing       | Request → handler mapping            | Route mapping table | `topology: Router`          |
| Sequence      | Ordered steps with data passing      | Step list editor    | `topology: Sequence`        |
| Schema        | Type hierarchy and composition       | Inheritance graph   | `Kernel.Definition`         |

Resources always belong to one paradigm determined by their kind's abstract base. The manifest is the shared layer — resources from different paradigms reference each other freely, and navigation between sub-editors is seamless.

New paradigms can be introduced by Telo modules: a module declares a definition with a `topology` field, and the editor activates the corresponding sub-editor for any resource whose kind uses that topology.

**Topology is required for navigation.** A resource whose kind declares no `topology` cannot be navigated to — it has no canvas view. Clicking it in the sidebar opens the detail panel (same as a Library item) without changing the canvas context. This rule is static and definition-level: it is determined by the kind's definition, not by whether the resource instance happens to have connections at authoring time.

The editor has **no built-in knowledge of any specific resource kind**. All display hints are declared on `Kernel.Definition` resources using annotations under the `editor.telo.run/` namespace, described in Section 6.

**The editor operates on pure YAML.** It reads YAML files and writes YAML files. It never loads npm packages, executes `pkg:` URIs, or imports JavaScript/TypeScript controllers. `controllers:` fields in `Kernel.Definition` documents are opaque strings to the editor — they are runtime artifacts and are ignored entirely. All information needed for display, validation, and authoring must be derivable from YAML documents alone.

---

## 1. Data Model

### Application

The editor's top-level in-memory model is an **Application** — the full connected component of local module files reachable from the root manifest via local-path imports:

```
Application
├── rootPath              (absolute path to the root module .yaml file)
├── modules               (Map<filePath, ParsedManifest> — all discovered modules)
├── importGraph           (Map<filePath, Set<filePath>> — directed submodule edges only)
└── importedBy            (Map<filePath, Set<filePath>> — reverse index)
```

Discovery is recursive: load the root manifest → follow all `Kernel.Import` entries whose `source` resolves to a local `.yaml` file → load each, recurse. Already-visited paths stop recursion. The result is a DAG of module files. Cycles are displayed as errors in the affected module's diagnostics but do not prevent loading the rest.

### Import Kinds

Not all `Kernel.Import` entries are equal. The editor classifies each by its `source` field:

| Kind                     | `source` pattern                            | Editor treatment                                                                                           |
| ------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Submodule**            | relative or absolute path to a `.yaml` file | Part of the Application; fully editable; navigable via breadcrumb                                          |
| **Remote module**        | `pkg:` URI or registry reference            | Not navigable; alias and exported kinds available read-only in the definition registry                     |
| **External application** | path or URL to another app's root module    | Read-only; definitions loaded into the registry for schema/ref purposes; resources never shown as editable |

The external application import type is reserved for future use (e.g. importing an external API's HTTP server definition to generate a matching client). It is not navigable and its resources do not appear in any sidebar section.

### ParsedManifest

A single module file maps to this structure:

```
ParsedManifest (= Module)
├── filePath     (absolute path to the .yaml file)
├── metadata     (name, version, description — from Kernel.Module)
├── targets[]    (list of Runnable resource names to boot)
├── imports[]    (Kernel.Import documents with resolved importKind)
└── resources[]
    └── each resource has:
        ├── kind        (e.g. "Http.Server")
        ├── name        (metadata.name)
        ├── module      (metadata.module)
        └── fields      (all remaining YAML key-value pairs as raw data)
```

### Resource Categories

The editor derives whether a resource belongs to the Library from the `capability` field on its `Kernel.Definition`.

| Category   | Detection                                    | Placement          |
| ---------- | -------------------------------------------- | ------------------ |
| `provider` | Definition has `capability: Kernel.Provider` | Library panel only |
| `type`     | Definition has `capability: Kernel.Type`     | Library panel only |

All other resources appear in the resource tree. Whether they appear on the canvas depends on the active canvas mode — canvas content is always slot-driven, never a blanket category filter.

Fields within a resource are raw YAML values. Their visual treatment is determined by:

1. Annotations on the `Kernel.Definition` for that kind (Section 6)
2. Structural inference from the value itself as a fallback (Section 7)

---

## 2. Layout

Three fixed panels:

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  TopBar: [⚡ Telo Editor]  [Open]       FeedbackApi  ›  Http.Server · Server   [Save] [Run] │
├────────────────────┬──────────────────────────────────┬──────────────────────────────┤
│                    │                                  │                              │
│  Sidebar           │  Graph Canvas (React Flow)       │  Detail Panel                │
│                    │                                  │  (opens on selection)        │
│  ── Imports ──     │  Flow mode (default):            │                              │
│    Http            │  root → runnable resources       │  Panel breadcrumb            │
│    Sql             │         + target toggles         │  ──────────────────────      │
│    Run        │  navigated → context + actual    │  Field list /                │
│                    │         connections              │  nested item content         │
│  ── Flow ──        │  selected → structurally         │                              │
│  ▶ FeedbackApi     │         connectable resources    │                              │
│    [HTTP]          │                                  │                              │
│      Server        │  Definitions mode:               │                              │
│      Routes (api)  │  type hierarchy + composition    │                              │
│    [Run]      │                                  │                              │
│      SetupDb       │  ○ = unselected node             │                              │
│                    │  ● = selected node               │                              │
│  ── Definitions ── │  ⊞ = context root node           │                              │
│    CrudEndpoints   │  ★ = module target               │                              │
│                    │                                  │                              │
│  ── Library ──     │                                  │                              │
│    [Providers]     │                                  │                              │
│      Db            │                                  │                              │
│    [Types]         │                                  │                              │
│      Feedback      │                                  │                              │
└────────────────────┴──────────────────────────────────┴──────────────────────────────┘
```

### TopBar

- App name (left)
- File open / create actions
- **Navigation breadcrumb** (center) — shows the path as `ModuleName › kind · name`; the module name is always the root crumb and is clickable to return to root context; the resource crumb appears only when navigated into a resource context
- Save and Run actions (right)

### Left Sidebar

See Section 3.

### Graph Canvas

See Section 4.

### Detail Panel

See Section 5. Empty when nothing is selected.

---

## 3. Sidebar

The sidebar has four sections: **Imports**, **Flow**, **Definitions**, and **Library**. Navigating within Flow or Definitions switches the canvas between the two corresponding modes — the active section drives what the canvas shows.

### 3.1 Imports Section

Lists all `kind: Kernel.Import` documents in the active module. Imports are visually grouped by kind:

```
── Imports ──
  [Submodules]
    AuthModule         ← local .yaml import — part of this application
    DatabaseModule
  [Remote]
    Http               ← pkg: / registry — read-only alias
    Sql
```

**Submodule imports** show a module icon and are navigable — clicking one pushes a new `module` entry onto the navigation stack and opens that module in the editor, exactly as today. Submodule nodes are fully editable.

**Remote imports** show only the alias. They are not navigable (the editor cannot follow `pkg:` or registry sources). Their exported kinds appear in the definition registry and the kind picker, but no enter affordance is shown.

**External application imports** (future) are shown with a lock icon. Not navigable, not editable.

The `+` affordance on the Imports section opens a two-option picker:

- **Add submodule** — prompts for a relative file path and an alias. If the file does not exist it is created with a minimal `Kernel.Module` document. The `Kernel.Import` is written with that path as `source` and the given alias as `metadata.name`. The new module is immediately added to the application graph.
- **Add remote import** — prompts for a registry reference or `pkg:` URI and an alias. Writes a `Kernel.Import` with that source. The editor does not resolve or load this source.

A context menu on each import entry provides a remove option. Removing a submodule import removes the `Kernel.Import` document from the active module's YAML but does not delete the submodule file.

### 3.2 Resource Tree

Contains the module root and all resources except providers and types. This is the navigation control for the graph canvas.

```
▶ FeedbackApi              ← module root (clickable — returns to root context)
    [HTTP]                 ← editor.telo.run/group
      Server
      Routes
    [Run]
      SetupDb
```

- The module root is always visible and always the outermost item
- Resources are grouped by `editor.telo.run/group`
- Resources with no group fall under "Uncategorized"
- Each tree item shows: resource name and a small kind badge colored by `editor.telo.run/color`
- Groups can be collapsed/expanded independently

**Clicking the module root** — resets context to null (root), clears selection, closes detail panel.

**Clicking a resource** — if the resource's kind declares a `topology`, sets graph context to that resource, clears selection, closes detail panel. If the kind has no `topology`, opens the detail panel without changing the canvas context (same behavior as a Library item).

The item currently serving as the graph context root is highlighted with an accent background. No secondary selection highlight is shown in the tree — selection state is only reflected in the canvas.

### 3.3 Library Section

Contains all `provider`- and `type`-category resources, grouped under their respective headings. These resources are never shown on the canvas.

```
── Library ──
  [Providers]       ← all provider-category resources
    Db
    StripeKey
  [Types]           ← all type-category resources
    Feedback
    User
```

- Library items are read-only in the tree; they cannot be navigated to (no canvas context for them)
- Clicking a Library item opens a lightweight **inline detail popover** within the sidebar showing its fields (same `FieldList` rendering as the detail panel)
- Providers and types are referenced from other resources via dropdowns in the detail panel (Section 5)
- Library items with diagnostics show a colored dot indicator (red for errors, amber for warnings) next to their name; clicking the item reveals the diagnostics at the top of the popover

### 3.4 Definitions Section

Lists all `kind: Kernel.Definition` documents declared locally in the manifest. **Navigating within this section switches the canvas to Definitions mode** — the canvas shows the type hierarchy and composition graph rather than the runtime resource graph.

```text
── Definitions ──
  CrudEndpoints
  PaginatedList
```

Each entry shows the definition name (the `metadata.name` value). **Clicking a definition** sets it as the canvas context in Definitions mode, showing that definition's schema, its `capability` chain, and any composition relationships.

Definitions imported from external modules (via `kind: Kernel.Import`) are visible in Definitions mode as read-only nodes but do not appear in this sidebar section — only locally-declared definitions are listed here.

Navigating back into the Flow section (clicking the module root or any Flow resource) returns the canvas to Flow mode.

### 3.5 Authoring Controls

Each sidebar section has a `+` affordance for creating and deleting resources.

**Creating a resource** — a `+` button opens an inline form with a kind picker and a name field. The kind picker is populated only from kinds exported by the manifest's imported modules (i.e. kinds present in the definition registry from imported sources). Submitting appends a new YAML document with `kind`, `metadata.name`, and schema-default field values to the manifest.

**Deleting a resource** — a context menu or inline icon on each sidebar item triggers deletion. A confirmation step is required. Deletion removes the corresponding YAML document from the manifest.

---

## 4. Graph Canvas (React Flow)

The canvas is the primary visual surface. It operates in one of two top-level modes determined by which sidebar section is active: **Flow mode** (navigating within the Flow section) or **Definitions mode** (navigating within the Definitions section). Clicking within the Flow section always returns the canvas to Flow mode; clicking within the Definitions section switches it to Definitions mode.

### Definitions Mode

Shows the type hierarchy for the manifest's local definitions alongside read-only nodes for definitions inherited from imported modules. Nodes represent `Kernel.Definition` resources; edges represent `capability` relationships and composition references. The detail panel in this mode functions as a schema builder — add properties, set types, configure `x-telo-ref` slots, and set `editor.telo.run/` annotations.

### Flow Mode Canvas Modes

Within Flow mode, the canvas operates in one of three sub-modes at any time. Providers and types are never rendered as nodes in Flow mode — they belong to the Library only.

**Root mode** (no context, no selection)

- Shows all Runnable resources (`capability: Kernel.Runnable`)
- Each node has a **target toggle** (star icon): clicking it adds or removes the resource from the module's `targets` list
- Nodes currently in `targets` are marked with a filled star and a distinct border style
- Edges show actual reference connections between resources

**Context mode** (context set, no selection)

- Shows the context resource as the center node (marked with a double border)
- Shows all resources that hold an actual reference to or from the context resource
- Edges show only the actual connections between these resources
- The context root node is selectable — clicking it opens the detail panel and transitions to connectable mode; the node renders with its compound state (double border + filled background)

**Connectable mode** (any resource selected)

- Shows resources whose kind can structurally connect to the selected resource's kind, determined from the definition registry's field maps: for each `x-telo-ref` entry in the selected kind's field map, resolve target kinds via `registry.getByCapability()` (for abstract targets) or `registry.getByKind()` (for concrete targets); also include any kind whose own field map resolves to include the selected kind. The union of both directions is the connectable set.
- Existing actual connections are shown as solid edges; absent but possible connections are shown as dashed edges
- Clicking a dashed edge or a compatible unconnected node provides an affordance to create the connection
- If the selected kind has no `x-telo-ref` entries in either direction, the canvas shows no nodes

Canvas mode always switches immediately when context or selection changes. `fitView` runs after every mode switch.

### Node Design

Each node is a card with:

- Kind badge (color from `editor.telo.run/color`)
- Resource name
- Summary fields from `editor.telo.run/card-fields` (read-only preview)
- Target star toggle (root mode only)

Node visual states:

| State                   | Visual                                             |
| ----------------------- | -------------------------------------------------- |
| Default                 | Standard card                                      |
| Context root            | Double border                                      |
| Selected                | Filled background                                  |
| Context root + selected | Double border + filled background                  |
| Module target           | Filled star + distinct border                      |
| Has errors              | Red border; error count badge on the node card     |
| Has warnings            | Amber border; warning count badge on the node card |

### Edges

An edge is drawn from resource A to resource B when any field in A is a reference slot in the kind's field map (`x-telo-ref`) and holds a `{kind, name}` value pointing to B. Edges are directed (arrowhead at target). In connectable mode, edges for absent-but-possible connections render as dashed.

### Interaction

**Single-click on a node** → **Select**: highlights the node, opens/updates the detail panel, switches canvas to connectable mode. This applies to all nodes including the context root — selecting the context root transitions to connectable mode while keeping it as the center node.

**Click on an empty canvas area** → clears selection, returns canvas to context mode (or root mode if no context).

**Clicking the active context root's sidebar item** — no-op if the context root is already selected; re-selects it (opens detail panel) if selection was cleared. Does not re-navigate.

Navigation (via sidebar, clicking a _different_ resource) always clears selection and closes the detail panel.

---

## 5. Detail Panel

### Panel Navigation Stack

The panel maintains a simple two-level stack: the selected resource at the root, and optionally one collection item drilled into. Drill-down can go arbitrarily deep.

```typescript
type PanelEntry =
  | { type: "resource"; kind: string; name: string }
  | { type: "item"; fieldPath: string[]; label: string }; // e.g. ['routes', '2']
```

Selecting a different resource always resets the stack to just the resource root entry.

### Panel Header

The panel header shows the resource name as a title. The tree already reflects which resource is active, so no breadcrumb trail is needed here.

When drilled into a collection item, a **← Back** link replaces the title, labeled with the parent resource name. Clicking it pops the stack one level.

### Field List

At `resource` entry: all resource fields rendered in order.
At `item` entry: only that item's fields rendered.

Field rendering is described in Section 7.

### Reference Fields

When a field is a reference slot in the field map (`x-telo-ref`), the editor resolves the target kind(s) via `registry.getByCapability()` (abstract targets) or `registry.getByKind()` (concrete targets) and unions the results. Rendering depends on the resolved category:

- All resolved kinds are `provider` or `type` → renders as a **dropdown** populated from the Library (all resources of matching kinds in the manifest).
- Otherwise → renders as a `ReferenceInput` (text input with autocomplete from resources of compatible kinds in the resource tree).

Each reference slot also offers an **inline definition form**: instead of picking an existing named resource, the user can expand the field to fill in the referenced definition's schema directly. This produces an inline resource that the kernel normalizes to a named resource at boot.

### Scope Fields

When a field is a scope slot in the field map (`x-telo-scope`), it renders in the detail panel as a collapsed block showing the count of resources declared inside it, with an **Enter** affordance. Clicking **Enter** is a canvas-level navigation: the breadcrumb gains a new crumb for the scope, the entire canvas switches to show only the resources declared within that scope, and the sidebar resource tree is replaced by the scope's own resource list. The user works inside the scope exactly as they would at the module root — the same canvas modes, same sidebar behavior, same detail panel.

Navigating back via the breadcrumb returns the canvas to the parent context.

Reference autocomplete within the scope is restricted to resources declared inside the scope plus singleton resources from the outer manifest (providers, types); resources from sibling scopes are not offered.

### Diagnostics

When the selected resource has diagnostics, they are shown above the field list as a stacked list of messages, each labeled with its severity (error, warning, etc.) and code. The list is ordered by severity — errors first, then warnings.

Diagnostics come from `AnalysisDiagnostic` objects whose `data.resource.name` matches the selected resource's name. The full `message` string is displayed; `code` is shown as a secondary label (e.g. `SCHEMA_VIOLATION`).

---

## 6. Resource Display Metadata (Annotations)

The editor reads `Kernel.Definition` resources from the manifest (and from imported modules' definitions) to determine how to display each kind. No kind-specific logic exists in the editor itself.

All annotations use the `editor.telo.run/` prefix and are placed in `metadata.annotations` on the `Kernel.Definition`.

### 6.0 Definition Registry

Before rendering any resource, the editor builds a **definition registry** mapping each fully-qualified kind to its `Kernel.Definition`. The registry is built from the entire application — all `ParsedManifest` objects in the application graph — and is rebuilt whenever any module in the application changes.

A kind is always keyed as `metadata.module + "." + metadata.name`. Definitions that omit `metadata.module` inherit the module name from the `Kernel.Module` document in the same file.

Loading order:

1. **All submodule definitions** — `kind: Kernel.Definition` documents from every module in the application graph (root module and all transitively reachable submodules). Because the application graph is fully loaded upfront, cross-submodule definitions are available without any depth limit.
2. **Remote import definitions** — for each `Kernel.Import` whose `importKind` is `remote`, the import's `source` is a `pkg:` or registry reference that cannot be fetched. The editor loads definitions from remote imports only if they were previously cached locally (e.g. resolved by the kernel into a local `node_modules` path that contains a `module.yaml`). If no local resolution exists, that import's definitions are absent from the registry and its kinds appear as unknown.
3. **Built-in abstracts** — `Kernel.Runnable`, `Kernel.Provider`, `Kernel.Type`, `Kernel.Invocable`, `Kernel.Service`, `Kernel.Mount`, `Kernel.Template` are always available without file loading.

Each definition's schema is processed by `buildReferenceFieldMap` at load time and the resulting field map is cached on the registry entry. The field map records every `x-telo-ref` slot (reference fields) and every `x-telo-scope` slot (scope fields) by field path, and is reused by the editor for edge rendering, connectable mode, reference dropdowns, and scope field rendering — no schema traversal happens at interaction time. The full field map structure, `anyOf` traversal rules, `x-telo-ref` URI format, `Kernel.Abstract` resolution via `getByExtends()`, and visual editor interaction contract are specified in [kernel/docs/resource-references.md](../../kernel/docs/resource-references.md) (Sections 1–4 and 10).

### 6.1 Kind-level Annotations

| Annotation                    | Value                       | Purpose                                                       |
| ----------------------------- | --------------------------- | ------------------------------------------------------------- |
| `editor.telo.run/group`       | string                      | Group label within the sidebar section (Flow or Library)      |
| `editor.telo.run/color`       | hex color string            | Accent color for the kind badge                               |
| `editor.telo.run/icon`        | icon identifier             | Icon shown on graph nodes and tree items                      |
| `editor.telo.run/card-fields` | comma-separated field names | Fields displayed on the graph node card (flow resources only) |

The sidebar section (Flow vs Library) and canvas visibility are derived from the definition's `capability` field, not from an annotation.

**Example:**

```yaml
kind: Kernel.Definition
metadata:
  name: Server
  module: Http
  annotations:
    editor.telo.run/group: "HTTP"
    editor.telo.run/color: "#3b82f6"
    editor.telo.run/icon: "server"
    editor.telo.run/card-fields: "port,baseUrl"
capability: Kernel.Service
controllers:
  - pkg:npm/@telorun/http-server@>=0.1.0
```

```yaml
kind: Kernel.Definition
metadata:
  name: Connection
  module: Sql
  annotations:
    editor.telo.run/group: "SQL"
    editor.telo.run/color: "#f59e0b"
capability: Kernel.Provider
controllers:
  - pkg:npm/@telorun/sql@>=0.1.0
```

### 6.2 Field-level Annotations

Field annotations are placed inside the definition's schema under `x-editor` blocks on individual field descriptors, co-locating display hints with schema constraints:

| Annotation                              | Value                       | Purpose                                                                                            |
| --------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| `editor.telo.run/field-type`            | `cel`, `code`, `secret`     | Overrides inferred field type for rendering                                                        |
| `editor.telo.run/code-language`         | `sql`, `javascript`, `yaml` | Syntax highlighting language for `code` fields                                                     |
| `editor.telo.run/collection-item-label` | field name                  | Which field of an array item is used as its label in the panel back button and drill-in affordance |

Reference slots and scope slots are declared in the definition schema via `x-telo-ref` and `x-telo-scope` respectively — not via `editor.telo.run/` annotations. The field map built from these keywords (§6.0) is the authoritative source for reference rendering, dropdown population, edge drawing, and connectable mode.

**Example (schema excerpt inside a definition):**

```yaml
schema:
  properties:
    sql:
      type: string
      x-editor:
        editor.telo.run/field-type: code
        editor.telo.run/code-language: sql
    connection:
      x-telo-ref: "std/sql#Connection" # Sql.Connection is a provider → renders as dropdown
    routes:
      type: array
      x-editor:
        editor.telo.run/collection-item-label: name
```

### 6.3 Fallbacks When Annotations Are Absent

| Missing annotation / definition         | Fallback                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `editor.telo.run/group`                 | Group labeled "Uncategorized"                                               |
| `editor.telo.run/color`                 | Neutral gray                                                                |
| `editor.telo.run/card-fields`           | Only resource name shown on node                                            |
| `editor.telo.run/collection-item-label` | Item index used as label (`[0]`, `[1]`, …)                                  |
| `editor.telo.run/field-type`            | Inferred from value structure (Section 7)                                   |
| No `Kernel.Definition` found for a kind | Treated as `flow`; node renders name only; fields rendered as raw YAML tree |

---

## 7. Field Rendering (Inference Fallback)

When no field-level annotation overrides the type, the editor infers rendering from the raw YAML value:

| Value type                       | Rendered as                                                                |
| -------------------------------- | -------------------------------------------------------------------------- |
| string matching `^\$\{\{.*\}\}$` | CEL input (syntax highlighted)                                             |
| string (single-line)             | Text input                                                                 |
| string (multi-line)              | Code area (plain)                                                          |
| number                           | Number input                                                               |
| boolean                          | Toggle                                                                     |
| array                            | Collapsed block with item count; "Open" button drills into the panel stack |
| object                           | Collapsed block with key count; "Open" button drills into the panel stack  |

Reference detection (whether a field is a cross-resource reference) comes from the field map — a field is a reference slot if its definition schema contains `x-telo-ref`. Value shape alone is never used to infer a reference.

---

## 8. State Model

```typescript
interface Application {
  rootPath: string;
  modules: Map<string, ParsedManifest>; // keyed by absolute file path
  importGraph: Map<string, Set<string>>; // filePath → submodule filePaths
  importedBy: Map<string, Set<string>>; // reverse index
}

interface EditorState {
  // Loaded application — source of truth for all views
  application: Application | null;

  // Which module is currently active (the canvas shows this module)
  activeModulePath: string | null;

  // Navigation history; current location is the last entry
  navigationStack: NavigationEntry[];

  // Which node is currently selected (detail panel open)
  selectedResource: { kind: string; name: string } | null;

  // Panel-local navigation stack; empty when nothing is selected
  panelStack: PanelEntry[];

  // Diagnostics indexed by filePath → resource name → diagnostics
  diagnosticsByResource: Map<string, Map<string, AnalysisDiagnostic[]>>;
}

type NavigationEntry =
  | { type: "module"; filePath: string; graphContext: { kind: string; name: string } | null }
  | { type: "scope"; resource: { kind: string; name: string }; fieldPath: string[] };
```

The active manifest is always `application.modules.get(activeModulePath)`. The current canvas context is always derived from `navigationStack[last]`. The `graphContext` within a `module` entry tracks which resource is the canvas root inside that module; `null` means the module root. A `scope` entry means the canvas is showing the resources inside a scope field.

When a `module` navigation entry's `filePath` differs from `activeModulePath`, `activeModulePath` is updated to match on push and restored to the previous value on pop.

There is no separate dirty buffer. All edits are applied directly to the relevant `ParsedManifest` in `application.modules` in-place. Saving serializes the changed manifest back to its `.yaml` file. Only the edited file is written; other modules in the application are not touched.

**State transition rules:**

- Navigating to a resource (sidebar click) → updates `graphContext` in the current `module` entry; clears `selectedResource`, empties `panelStack`
- Entering a scope field (**Enter** on a scope block) → pushes a `scope` entry onto `navigationStack`; clears `selectedResource`, empties `panelStack`
- Opening an imported module → pushes a new `module` entry onto `navigationStack`; clears `selectedResource`, empties `panelStack`
- Clicking a breadcrumb crumb → pops `navigationStack` back to that entry; clears `selectedResource`, empties `panelStack`
- Setting `selectedResource` (select) → resets `panelStack` to `[{ type: 'resource', ...selectedResource }]`; does not change `navigationStack`
- Clearing `selectedResource` (click empty canvas area) → empties `panelStack`; does not change `navigationStack`

**Diagnostics:** `StaticAnalyzer.analyze()` is called after every change to any module in the application. A single `AnalysisContext` (carrying `AliasResolver` and `DefinitionRegistry`) is kept alive for the lifetime of the open application and passed to each `analyze()` call. The returned `AnalysisDiagnostic[]` is regrouped into `diagnosticsByResource` keyed first by file path, then by resource name. `diagnosticsByResource` is excluded from `localStorage` persistence — it is always recomputed on load.

**Persistence:** `EditorState` (excluding `application` and `diagnosticsByResource`) is serialized to `localStorage` on every change and restored on page load — specifically `activeModulePath`, `navigationStack`, `selectedResource`, and `panelStack`. The application itself is always reloaded from disk. There is no URL routing — the editor is a single page.

**Canvas mode derived from state:**

```
navigationStack[last].type == 'scope'                                →  scope mode (resources inside the scope field)
navigationStack[last].type == 'module' && selectedResource != null   →  connectable mode
navigationStack[last].type == 'module' && graphContext != null       →  context mode
otherwise                                                            →  root mode (runnable resources)
```

In scope mode the canvas behaves identically to root/context/connectable mode but the resource set is the contents of the scope field rather than the module's top-level resources.

---

## 9. Routing Sub-editor

Activated when navigating to any resource whose kind's definition declares `topology: Router` (e.g. `Http.Api`). The center canvas space is replaced by a **route mapping table** for the duration of the navigation context.

### Layout

```
┌────────────┬──────────────────────────────────────────────────┬──────────────┐
│  Sidebar   │  Route Mapping Table                             │  Detail      │
│            │                                                  │  Panel       │
│  ── Flow ──│  POST  /feedback         InsertFeedback          │              │
│  ► FeedbackRoutes  GET   /feedback         ListFeedback        │  Request     │
│    SetupDb │  GET   /feedback/{id}    GetFeedback             │  ──────────  │
│            │                                                  │  POST        │
│            │  [+ Add route]                                   │  /feedback   │
│            │                                                  │              │
│            │                                                  │  Handler     │
│            │                                                  │  ──────────  │
│            │                                                  │  InsertFeed  │
│            │                                                  │              │
│            │                                                  │  Response    │
│            │                                                  │  ──────────  │
│            │                                                  │  201 Created │
│            │                                                  │  400 Error   │
└────────────┴──────────────────────────────────────────────────┴──────────────┘
```

### Route Mapping Table

Each row displays the route's matcher fields (e.g. method and path for HTTP) and the name of the attached handler invocable. Matcher column contents are determined by the kind's schema — the routing sub-editor reads whichever fields are not the handler and renders them as the row label.

**Clicking a row selects it** — the detail panel opens showing the route's fields grouped into three sections:

1. **Request** — matcher fields (method, path, headers, etc.)
2. **Handler** — the `x-telo-ref` invocable slot; rendered as a `ReferenceInput` with autocomplete from invocable resources in the manifest
3. **Response** — response descriptor fields (status codes, schemas, etc.)

The route table remains visible while a row is selected. Clicking an empty area of the table clears the selection and closes the detail panel.

### Authoring

**Adding a route** — `[+ Add route]` appends a new row with empty matcher fields and no handler. Fields are edited via the detail panel after selecting the row.

**Removing a route** — context menu on the row. Does not delete the handler resource, only the route entry.

---

## 10. Sequence Sub-editor

Activated when navigating to any resource whose kind's definition declares `topology: Sequence` (e.g. `Job.Steps`). The center canvas space is replaced by a **step tree** — a vertically stacked, hierarchical list of steps. Steps can be reordered by dragging. Control flow steps nest child steps beneath them with indentation.

### Step Types

See [kernel/docs/topologies/sequence.md](../../kernel/docs/topologies/sequence.md) for the full step type reference (`invoke`, `if`, `while`, `switch`) and data passing semantics.

Also see module `modules/run` for the concrete `Sequence` resource kind that the editor supports as step invocables.

### Layout

```
┌────────────┬──────────────────────────────────────────────────┬──────────────┐
│  Sidebar   │  Step Tree                                       │  Detail      │
│            │                                                  │  Panel       │
│  ── Flow ──│  ┌─────────────────────────────────────────┐    │              │
│  ► SetupDb │  │ 1. FetchUser            Sql.Read       ⠿ │    │  (step fields│
│            │  └─────────────────────────────────────────┘    │  when a step │
│            │            ↓                                     │  is selected)│
│            │  ┌─────────────────────────────────────────┐    │              │
│            │  │ 2. ◇ if: user.verified                ⠿ │    │              │
│            │  │   ├── then                               │    │              │
│            │  │   │    3. ProcessPayment   Payment.Pro   │    │              │
│            │  │   └── else                               │    │              │
│            │  │        3. RejectRequest   Payment.Rej   │    │              │
│            │  └─────────────────────────────────────────┘    │              │
│            │            ↓                                     │              │
│            │  ┌─────────────────────────────────────────┐    │              │
│            │  │ 4. Notify           Http.Client        ⠿ │    │              │
│            │  └─────────────────────────────────────────┘    │              │
│            │                                                  │              │
│            │  [+ Add step]                                    │              │
└────────────┴──────────────────────────────────────────────────┴──────────────┘
```

`⠿` is the drag handle for reordering. Control flow steps can be collapsed/expanded.

### Step Cards

Invoke step cards show: step index, name, and the invocable kind and resource name.

Control flow step cards show: step index, name, the control flow type symbol (`◇` for if/switch, `↻` for while), and the condition expression. Child steps are indented beneath, each with their own cards.

Clicking any step card selects it — the detail panel opens showing that step's fields. The step tree remains visible while a step is selected.

### Data passing between steps

Steps reference previous step outputs via CEL in the `inputs` field: `${{ steps.CreateTable.result }}`. The detail panel renders these as CEL inputs with autocomplete scoped to steps preceding the current one in the list — forward references are not offered.

When `concurrency > 1` is set on the job, `steps.X.result` references are invalid because steps run simultaneously and execution order is not guaranteed. In this case the editor omits `steps.*` from CEL autocomplete suggestions in all step `inputs` fields. The field remains editable but the editor does not guide the author toward an invalid reference.

### Authoring

**Adding a step** — `[+ Add step]` appends a new card at the end. The invoke block is populated via the toolbox (same toolbox pattern as the routing sub-editor: existing invocable instances + create new by kind).

**Reordering** — drag by the handle (`⠿`). CEL references in `inputs` that refer to steps by name remain valid after reorder; references that relied on order-based assumptions are the author's responsibility.

**Removing a step** — context menu on the card. Does not delete the invocable resource, only the step entry.

---

## 11. Control Flow Across Topologies

Control flow concepts (`if`, `while`, `switch`) are expressed differently depending on the topology they appear in, but use the same underlying resource kinds from the `Flow` module.

### In Sequence

See [kernel/docs/topologies/sequence.md](../../kernel/docs/topologies/sequence.md).

### In Workflow (future)

See [kernel/docs/topologies/workflow.md](../../kernel/docs/topologies/workflow.md).

---

## 12. Component Tree

```
<Editor>
  <TopBar activeManifest={activeManifest} navigationStack={navigationStack} />

  <Shell>
    <Sidebar>
      <ImportsSection
        activeManifest={activeManifest}
        application={application}
        onOpenModule={openModule}      // pushes a module entry onto navigationStack
      />
      <ResourceTree
        activeManifest={activeManifest}
        navigationStack={navigationStack}
        onNavigate={navigate}          // updates graphContext in current module entry; switches to flow mode
      />
      <DefinitionsSection
        activeManifest={activeManifest}
        onNavigate={navigateDefinition} // switches canvas to definitions mode
      />
      <LibrarySection
        activeManifest={activeManifest}
      />
    </Sidebar>

    <GraphCanvas
      mode={canvasMode}              // "flow" | "definitions" | "scope"
      activeManifest={activeManifest}
      navigationStack={navigationStack}
      selectedResource={selectedResource}
      onSelect={setSelectedResource}
      onClearSelection={clearSelection}
      onTargetToggle={toggleTarget}
    />

    <DetailPanel
      stack={panelStack}
      activeManifest={activeManifest}
      onDrillIn={pushPanel}
      onBack={popPanel}
      onEnterScope={enterScope}      // pushes a scope entry onto navigationStack
    />
  </Shell>
</Editor>
```

### Key Components

| Component            | Purpose                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `ImportsSection`     | Lists all `Kernel.Import` entries; clicking one opens that module in the editor               |
| `ResourceTree`       | Navigable list of non-Library resources; navigating here sets Flow mode                       |
| `DefinitionsSection` | Lists local `Kernel.Definition` entries; navigating here sets Definitions mode                |
| `LibrarySection`     | Sidebar library section; lists providers and types; opens inline popover on click             |
| `LibraryItemPopover` | Inline field view for a provider or type resource within the sidebar                          |
| `GraphCanvas`        | React Flow canvas; Flow mode (root/context/connectable) or Definitions mode                   |
| `ResourceNode`       | React Flow custom node; kind badge, name, summary fields, optional target star                |
| `KindBadge`          | Colored tag with kind name; color from `editor.telo.run/color`                                |
| `DetailPanel`        | Right panel; renders field list for selected resource or nested item                          |
| `FieldList`          | Ordered list of fields for a resource or panel item                                           |
| `FieldRow`           | Single field: label + input based on inferred or annotated type                               |
| `CollectionBlock`    | Collapsed array/object with item count and drill-in button                                    |
| `CelInput`           | Syntax-highlighted input for `${{ ... }}` expressions                                         |
| `CodeArea`           | Multiline code input with optional syntax highlighting                                        |
| `ReferenceInput`     | Text input with autocomplete for `flow` reference fields                                      |
| `ProviderSelect`     | Dropdown for `provider`/`type` reference fields; populated from Library                       |
| `DiagnosticBadge`    | Colored dot/count indicator shown on nodes and library items when diagnostics exist           |
| `DiagnosticList`     | Stacked list of diagnostic messages shown at the top of the detail panel and library popovers |

---

## 13. Future Considerations

Out of scope for the initial implementation but should not be designed against:

- **Multi-manifest workspace**: cross-manifest resource reference visibility; inter-manifest edges in the graph
- **Validation panel**: field-level error markers sourced from schema validation, surfaced on graph nodes and in the detail panel
- **Module registry integration**: browse `apps/registry` when adding a `Kernel.Import`
- **Live YAML diff**: side-by-side view of raw YAML changes as fields are edited
- **Graph layout options**: user-selectable layout algorithms (hierarchical, force-directed, radial)
- **Multi-hop connectable mode**: extend connectable view beyond 1-hop to show transitive structural connections
