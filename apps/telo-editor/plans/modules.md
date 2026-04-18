# Modules in telo editor

## Goal

Replace the "Modules vs Imports" sidebar split with a directory-based workspace model. A module is a directory containing a `telo.yaml`. The sidebar becomes a tree of modules; navigation is direct (no breadcrumb). The editor supports multi-application workspaces on top of the kernel's `Telo.Application` / `Telo.Library` split.

## Non-goals

- Storage migration. The state shape changes; old stored state is dropped on load.
- Declarative app-to-app execution.
- Drag-to-rearrange / drag-to-rename of modules in the tree.

---

## UX changes

### Sidebar: split Workspace tree (Applications / Libraries)

- Replaces the `Modules` section and the breadcrumb.
- Two sibling sections, each with its own header and add action:
  - **Applications** header → `New application` action. Lists every directory under the workspace root whose `telo.yaml` declares `kind: Telo.Application`.
  - **Libraries** header → `New library` action. Lists every directory whose `telo.yaml` declares `kind: Telo.Library`.
- Splitting by header (rather than a unified tree with mixed icons and a single "New module" button that asks for kind) makes module kind an upfront choice tied to where the author clicks. It also removes the "what happens if I add in the wrong place" retroactive-fix problem, since Application-only fields like `targets` are gated at parse time.
- Within each section: one node per directory under the workspace root matching that kind. No other folders appear.
- Applications render with an Application icon and a Run affordance. Libraries render with a Library icon.
- Expanding a module reveals its `include:`-reachable partial files as leaf nodes (click → opens the partial in source view).
- **"No importers" badge** on a Library with no transitive importer from any Application in the workspace (_any_ Application — tests, examples, apps). Rendered dimmed. Wording is deliberate: "no importers" is a neutral observation, not a judgement ("unused" or "orphan" would misread WIP libraries and test-only helpers as broken).
- Empty-section hints: an empty Applications section shows "No applications yet" with the `New application` action inline; same for Libraries.

### Sidebar: Imports section (per active module)

- Stays. What moves to the workspace tree is _module discovery_ (the "browse all submodules" UX), not imports themselves — imports are a property of a module and stay listed on it.
- Drops the old three-way `submodule`/`remote`/`external` filter chips. Shows **all** of the active module's imports in one unified list — `local`, `registry`, `remote` — differentiated by a per-entry icon.
- Registry entries retain the version badge and upgrade dropdown ([Sidebar.tsx:400-426](apps/telo-editor/src/components/Sidebar.tsx#L400-L426)); those affordances key off `ImportKind === "registry"`.
- Keeps `+` (add), remove, and upgrade actions.

### Navigation

- Clicking a workspace tree node sets `activeModulePath` directly. No stack, no breadcrumb push.
- `TopBar` renders the active module name + path as a static label; the clickable breadcrumb chips are removed.

### Workspace open

- User picks a directory (Tauri picker / Chrome FSA picker).
- Editor scans the tree for every `telo.yaml` and loads each as a module.
- Module `kind` (`Telo.Application` or `Telo.Library`) classifies the node.
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
  modules: Map<string, ParsedManifest>; // keyed by module directory (absolute)
  importGraph: Map<string, Set<string>>; // module dir → library module dirs it imports
  importedBy: Map<string, Set<string>>; // reverse index
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

- **`TauriWorkspaceAdapter`** — `@tauri-apps/plugin-fs` for every filesystem op (read, write, listDir, delete, createDir). The existing Rust `read_file` invoke path is removed as part of this change; the plugin is the single Tauri filesystem surface. Clean cut, not a read-vs-write split — two code paths for the same concept would be a maintenance hazard.
- **`FsaWorkspaceAdapter`** — Chrome/Edge File System Access API. Extends current read-only FSA adapter with writes. Requests read+write permission in a single gesture at directory-pick time, so the first actual save doesn't fail with a surprise permission prompt mid-edit.
- **`LocalStorageWorkspaceAdapter`** — browser fallback when FSA is unavailable (Firefox/Safari). Stores files under a keyed prefix per workspace in `window.localStorage` (key = `${prefix}/${relativePath}`, value = UTF-8 text). Acceptable because manifests are small text and a workspace rarely exceeds a few dozen files — the ~5 MB origin quota is not a realistic ceiling for YAML. If that assumption breaks for a user, revisit with IndexedDB; don't pre-invest.

The same object may implement both `ManifestAdapter` and `WorkspaceAdapter` but the interfaces stay split so runtime code never takes a dependency on mutation APIs.

File watching (`watch?`) is deliberately out of scope for v1. External edits made outside the editor require a manual workspace reload. Keeps the initial surface small and sidesteps cross-platform watcher differences (Tauri notify events, FSA's lack of change notifications, localStorage's `storage` event).

---

## Component changes

### `Sidebar.tsx`

- Remove the Modules section ([Sidebar.tsx:317-389](apps/telo-editor/src/components/Sidebar.tsx#L317-L389)).
- Add `<WorkspaceTree>` at the top of the sidebar.
- Imports section: drop the `submodule` branch (submodules move to the workspace tree). Keep `registry` and `remote` as distinct so the version badge and upgrade dropdown still key off `registry`.
- Remove `onPickModuleFile` and `onAddModule` props. Module creation is a workspace-tree action; imports are unchanged.

### `<WorkspaceTree>` (new)

- Renders two sections — `Applications` and `Libraries` — from `workspace.modules`, partitioned by `ParsedManifest.kind`. Each section is keyed by directory path and sorted by filesystem order.
- Each section header has its own add action: `New application` and `New library`. Each prompts only for the module name; the parent directory is fixed by the section — `apps/<name>` for applications, `libs/<name>` for libraries. The kind is fixed by which header was clicked. No per-node "New module here" — avoids the "inside vs next to" ambiguity and matches how authors organize modules (typically siblings, not nested). The fixed parent removes the second form field entirely; if an author needs a different layout they can rename the directory on disk.
- Per-node interactions:
  - Click → `onOpenModule(path)`.
  - Inline Run icon on every Application node (ghost-style, small). Not shown in the Libraries section.
  - Context menu → `Delete module`, `Reveal in filesystem`.
- **Delete cascade.** `Delete module` shows a confirmation that lists every importer of the target (using `workspace.importedBy`). On confirm: remove the target directory via `WorkspaceAdapter.delete`, then rewrite each importer to drop its `Telo.Import` entry pointing at the deleted path. A plain filesystem delete would leave dangling imports that subsequently fail analyzer validation; handling the graph edge here beats making the author chase diagnostics. If the user cancels, nothing changes.
- Visual treatment:
  - Application / Library icon per node (section-consistent).
  - Active module highlighted.
  - Libraries with no transitive importer from any Application rendered dimmed with a `no importers` badge (see UX section for wording rationale). No hide-toggle — authors should see what's unwired.
  - Empty sections render a muted "No applications yet" / "No libraries yet" hint with the section's add action inline.

### `TopBar.tsx`

- Remove breadcrumb rendering and `onPopTo`.
- Show active module name + path as a static label.
- When the active module is a `Telo.Application`, show a prominent Run button. (Complements the inline Run icons on Application nodes in the tree.)

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

## Open items

None at plan-time. Items decided during design:

- The workspace tree is split into `Applications` and `Libraries` sections, each with its own add action (`New application` / `New library`). Kind is determined by the section, not by a dialog radio. Add actions live on the section header, not per-node. The creation form asks only for the module name; parent directories are fixed per-kind (`apps/` / `libs/`).
- Run action appears both as an inline icon on each Application node and as a prominent button in the TopBar when an Application is active.
- Libraries with no transitive importer from any Application are dimmed with a `no importers` badge; no hide-toggle.
- FSA read+write permission is requested together at directory-pick time.
- Tauri filesystem layer is fully migrated to `@tauri-apps/plugin-fs`; the Rust `read_file` invoke is removed.
- Browser fallback (Firefox/Safari) uses `localStorage` under a workspace-keyed prefix; IndexedDB deferred until the ~5 MB quota proves insufficient in practice.
- File watcher support is deferred; external edits require a manual workspace reload.
