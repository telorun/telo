# Modules in telo editor

## Goal

Replace the "Modules vs Imports" sidebar split with a directory-based workspace model. A module is a directory containing a `telo.yaml`. The sidebar becomes a tree of modules; navigation is direct (no breadcrumb). The editor supports multi-application workspaces on top of the kernel's `Kernel.Application` / `Kernel.Library` split.

## Non-goals

- Storage migration. The state shape changes; old stored state is dropped on load.
- Declarative app-to-app execution.
- Drag-to-rearrange / drag-to-rename of modules in the tree.

---

## UX changes

### Sidebar: unified Workspace tree

- Replaces the `Modules` section and the breadcrumb.
- One node per directory under the workspace root that contains a `telo.yaml`. No other folders appear.
- Applications render with a distinct icon and a Run affordance. Libraries render plain.
- Expanding a module reveals its `include:`-reachable partial files as leaf nodes (click → opens the partial in source view).
- **"No importers" badge** on a Library with no transitive importer from any Application in the workspace (*any* Application — tests, examples, apps). Rendered dimmed. Wording is deliberate: "no importers" is a neutral observation, not a judgement ("unused" or "orphan" would misread WIP libraries and test-only helpers as broken).

### Sidebar: Imports section (per active module)

- Stays. What moves to the workspace tree is *module discovery* (the "browse all submodules" UX), not imports themselves — imports are a property of a module and stay listed on it.
- Drops the old three-way `submodule`/`remote`/`external` filter chips. Shows **all** of the active module's imports in one unified list — `local`, `registry`, `remote` — differentiated by a per-entry icon.
- Registry entries retain the version badge and upgrade dropdown ([Sidebar.tsx:400-426](apps/telo-editor/src/components/Sidebar.tsx#L400-L426)); those affordances key off `ImportKind === "registry"`.
- Keeps `+` (add), remove, and upgrade actions.

### Navigation

- Clicking a workspace tree node sets `activeModulePath` directly. No stack, no breadcrumb push.
- `TopBar` renders the active module name + path as a static label; the clickable breadcrumb chips are removed.

### Workspace open

- User picks a directory (Tauri picker / Chrome FSA picker).
- Editor scans the tree for every `telo.yaml` and loads each as a module.
- Module `kind` (`Kernel.Application` or `Kernel.Library`) classifies the node.
- Active module selection on load:
  1. First Application in tree order, if any.
  2. Otherwise first Library in tree order. (Libraries are editable; the Run action simply doesn't appear.)
  3. Otherwise `null`, and the empty state shows.
- Empty state (no `telo.yaml` under root) offers "Create application here".

### Scan exclusions

`scanWorkspace` skips directories matching any of: `node_modules`, `dist`, `.git`, `pages/build` (Docusaurus output), `__fixtures__` (per CLAUDE.md's test-discovery rule — fixture manifests must not appear as workspace modules). The list lives as a constant in the editor package; the runtime's `ManifestAdapter` is unaffected (runtime only follows imports, not filesystem walks).

---

## Data model

### `ParsedManifest`

- Add `kind: "Application" | "Library"` derived from the module doc at parse time.
- `targets` valid only when `kind === "Application"`. Parser rejects `targets` on a Library.
- Rename `ImportKind` values for clarity but **keep three flavors**: `"local" | "registry" | "remote"` (local = relative path, registry = versioned registry reference, remote = raw URL or `pkg:` scheme). Collapsing registry + remote into one kind would regress the version badge and upgrade dropdown in the Imports sidebar ([Sidebar.tsx:400-426](apps/telo-editor/src/components/Sidebar.tsx#L400-L426)), which are registry-specific affordances.

### `Application` → `Workspace`

Rename and reshape (file: [model.ts:64-69](apps/telo-editor/src/model.ts#L64-L69)):

```ts
interface Workspace {
  rootDir: string;
  modules: Map<string, ParsedManifest>;   // keyed by module directory (absolute)
  importGraph: Map<string, Set<string>>;  // module dir → library module dirs it imports
  importedBy: Map<string, Set<string>>;   // reverse index
}
```

`importGraph` is purely display metadata (no-importer detection, dependency badges). It no longer governs workspace membership — the filesystem does.

### `EditorState`

- Drop `navigationStack`.
- Rename `application` → `workspace`.
- Keep `activeModulePath`, `activeView`, `selectedResource`, `panelStack`, `diagnosticsByResource`.

---

## Filesystem layer

### `ManifestAdapter` (read-only, shared with runtime) — unchanged

Stays in `@telorun/analyzer` with its existing surface (`read`, `readAll`, `resolveRelative`, `expandGlob`, `resolveOwnerOf`).

### `WorkspaceAdapter` (new, editor-only)

Lives in the editor package. Adds mutation and workspace-scoped listing:

```ts
interface WorkspaceAdapter {
  writeFile(path: string, text: string): Promise<void>;
  createDir(path: string): Promise<void>;
  delete(path: string): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  watch?(path: string, cb: (event: FsEvent) => void): Disposable;
}
```

Implementations:

- **`TauriWorkspaceAdapter`** — `@tauri-apps/plugin-fs`.
- **`FsaWorkspaceAdapter`** — Chrome/Edge File System Access API. Extends current read-only FSA adapter with writes. Requests read+write permission in a single gesture at directory-pick time, so the first actual save doesn't fail with a surprise permission prompt mid-edit.
- **`IndexedDbWorkspaceAdapter`** — browser fallback when FSA is unavailable. Backs new/unsaved workspaces and edits in Firefox/Safari.

The same object may implement both `ManifestAdapter` and `WorkspaceAdapter` but the interfaces stay split so runtime code never takes a dependency on mutation APIs.

---

## Component changes

### `Sidebar.tsx`

- Remove the Modules section ([Sidebar.tsx:317-389](apps/telo-editor/src/components/Sidebar.tsx#L317-L389)).
- Add `<WorkspaceTree>` at the top of the sidebar.
- Imports section: drop the `submodule` branch (submodules move to the workspace tree). Keep `registry` and `remote` as distinct so the version badge and upgrade dropdown still key off `registry`.
- Remove `onPickModuleFile` and `onAddModule` props. Module creation is a workspace-tree action; imports are unchanged.

### `<WorkspaceTree>` (new)

- Renders a tree from `workspace.modules` keyed by directory path.
- Header has a single `New module` action that prompts for a path relative to workspace root. No per-node "New module here" — avoids the "inside vs next to" ambiguity and matches how authors actually organize modules (typically siblings, not nested).
- Per-node interactions:
  - Click → `onOpenModule(path)`.
  - Inline Run icon on every `Kernel.Application` node (ghost-style, small).
  - Context menu → `Delete module`, `Reveal in filesystem`.
- **Delete cascade.** `Delete module` shows a confirmation that lists every importer of the target (using `workspace.importedBy`). On confirm: remove the target directory via `WorkspaceAdapter.delete`, then rewrite each importer to drop its `Kernel.Import` entry pointing at the deleted path. A plain filesystem delete would leave dangling imports that subsequently fail analyzer validation; handling the graph edge here beats making the author chase diagnostics. If the user cancels, nothing changes.
- Visual treatment:
  - Application/Library icon per node.
  - Active module highlighted.
  - Libraries with no transitive importer from any Application rendered dimmed with a `no importers` badge (see UX section for wording rationale). No hide-toggle — authors should see what's unwired.

### `TopBar.tsx`

- Remove breadcrumb rendering and `onPopTo`.
- Show active module name + path as a static label.
- When the active module is a `Kernel.Application`, show a prominent Run button. (Complements the inline Run icons on Application nodes in the tree.)

### `Editor.tsx`

- Drop `navigationStack`, `handleOpenModule` (stack push), `handlePopTo`.
- Replace with `setActiveModulePath(path)`.
- Replace `handleAddModule` (which writes an import) with `handleCreateModule` (creates a directory + `telo.yaml` via `WorkspaceAdapter`).
- Workspace bootstrap: replace `loadApplication(rootPath)` with `loadWorkspace(rootDir)` — filesystem scan, not import traversal.

### `loader.ts`

- `classifyImport`: rename the `"submodule"` result to `"local"`; keep `"registry"` (formerly `"external"`) and `"remote"` distinct. Result type is `"local" | "registry" | "remote"`.
- Add `scanWorkspace(rootDir, adapter)` that walks the directory tree and returns every module.
- Replace `loadApplication` with `loadWorkspace`.
- Remove `pruneUnreachableModules` — membership is filesystem-driven.
- Rename `addModuleImport` → `addImport`.
- `buildParsedManifest`: detect either `Kernel.Application` or `Kernel.Library` as the module identity doc; populate `ParsedManifest.kind` from it.
- [`toManifestDocs`](apps/telo-editor/src/loader.ts#L777) currently hardcodes `kind: "Kernel.Module"` on serialize ([loader.ts:779](apps/telo-editor/src/loader.ts#L779)). Update it to emit `ParsedManifest.kind` (`"Kernel.Application"` or `"Kernel.Library"`) and to skip `targets` when the kind is Library. Otherwise saving any file round-trips through the old kind and breaks schema.

---

## Storage

- Bump the storage key version; drop old persisted state on load.
- Persist `{ rootDir, activeModulePath, activeView, settings }`.

---

## Removal list

- `NavigationEntry`, `navigationStack`, `handlePopTo` across `Editor.tsx`, `model.ts`, `TopBar.tsx`, `storage.ts`.
- `submodule` value in `ImportKind` (renamed to `local`; the three-way distinction survives for registry vs raw-remote handling).
- `onPickModuleFile`, `onAddModule` props (folded into tree context menu).
- "No submodules" empty hint and the add-module form in `Sidebar.tsx`.
- `pruneUnreachableModules` helper.

---

## Dependency on kernel plan

Assumes `Kernel.Module` has been split into `Kernel.Application` + `Kernel.Library`. Editor reads the `kind` field directly from each parsed `telo.yaml` to classify nodes.

**The transitional parser is required regardless of shipping order.** Phase 2 of the kernel plan's migration is a hand-review pass across tests, examples, apps, and benchmarks — while that pass is in flight, the workspace will contain a mix of legacy `Kernel.Module` files and migrated `Kernel.Application` / `Kernel.Library` files. The editor must not break on legacy kind during that window. Rule for `buildParsedManifest`:

- `Kernel.Application` → `ParsedManifest.kind = "Application"`.
- `Kernel.Library` → `ParsedManifest.kind = "Library"`.
- `Kernel.Module` (legacy): Application iff the doc declares `targets:`, else Library. Tag the manifest internally as "legacy-classified" so the UI can surface a subtle badge prompting migration.

The transitional parser stays in the codebase until Phase 2 is complete across the repo; then it is removed.

---

## Open items

None at plan-time. Items decided during design:

- New-module action lives on the tree header, not per-node — prompts for a path relative to workspace root.
- Run action appears both as an inline icon on each Application node and as a prominent button in the TopBar when an Application is active.
- Libraries with no transitive importer from any Application are dimmed with a `no importers` badge; no hide-toggle.
- FSA read+write permission is requested together at directory-pick time.
