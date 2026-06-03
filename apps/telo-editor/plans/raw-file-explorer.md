# Raw File Explorer

## Problem

The telo editor only surfaces *parsed* telo modules. The sidebar's WorkspaceTree
lists Applications and Libraries (already derived from a whole-workspace scan in
`loadWorkspace` / `scanWorkspace`), and the center pane is locked to a single
active module. There is no way to see or edit the raw files of a workspace —
`README.md`, `.json`, configs, included partials, anything that isn't a
`telo.yaml` root. Users need a VSCode-style raw view of the workspace alongside
the structured one, and a place to render non-telo files.

## Solution

Two coordinated additions: a raw file-tree section in the sidebar, and a unified
open-editors tab strip that becomes the editor's single selection surface.

**File explorer (sidebar).** A new section rendered at the top of
`components/sidebar/Sidebar.tsx`, above WorkspaceTree, reusing the existing row
primitives. It shows the full directory tree, walked eagerly through
`WorkspaceAdapter.listDir`, reusing the scanner's exclusion sets (`.git`,
`dist`, `node_modules`, …) so the tree is driven entirely by the adapter and not
by any hardcoded filesystem access. This keeps it extensible: future remote-dir
and git-repo backends implement the same adapter and the explorer works
unchanged. The explorer supports create file/folder, rename, delete, and
drag-drop move.

**Unified open-editors tabs.** The center pane gains a tab strip that replaces
the current single-`activeModulePath` model. Two tab kinds:
- *Module tab* — opened by clicking an app/lib in the structured tree or a
  `telo.yaml` in the explorer; renders the existing `ViewContainer`
  (topology/inventory/source/deployment) scoped to that module. The structured
  experience is unchanged, just hosted inside a tab.
- *File tab* — opened by clicking a non-telo file; renders a Monaco editor over
  the raw text. Non-text/binary files render a "can't preview" placeholder
  instead of feeding Monaco garbage.

**Plumbing.** `WorkspaceAdapter` gains a `rename(from, to)` primitive,
implemented natively in the Tauri, File System Access, and localStorage
backends. Any file operation that touches telo structure (creating/deleting/
renaming a `telo.yaml`, or changing `include`d files) triggers a workspace
re-scan/re-parse via the existing reload path so Applications/Libraries stays in
sync. `EditorState` is extended with the open-tabs list, active tab, and
expanded-folder set, all persisted through the existing
`useEditorPersistence` localStorage path.

Primary files: `components/sidebar/Sidebar.tsx` (new section),
`components/Editor.tsx` (tab state + file-op handlers + reload wiring),
`model.ts` (EditorState + `WorkspaceAdapter` interface), the three adapters
under `loader/adapters/`, and new explorer + tab-strip + file-tab components
under `components/`.

## Decisions

- **Unified tabs for both modules and files**, not raw-files-only — avoids two
  parallel selection models; a non-telo file has no module to hang off the
  current `activeModulePath` surface. Rejected: a side-by-side raw pane (loses
  flip-between, confusing dual selection).
- **Explorer stacked above WorkspaceTree** in the same sidebar — keeps both
  views visible at once. Rejected: an activity-bar mode toggle (hides one view,
  more chrome than needed now).
- **Eager full-tree walk via the adapter**, not a hardcoded fs walk — full tree
  was requested, and routing through `WorkspaceAdapter` keeps remote/git
  backends pluggable later. Lazy expansion can be layered on the same adapter
  call if large workspaces demand it.
- **Reuse scanner exclusions** (`.git`/`dist`/`node_modules`) — consistent with
  module discovery, avoids noise.
- **`rename` added to the adapter interface** rather than emulated via
  read+write+delete — emulation is lossy for directories and binary files.
- **Telo structure changes trigger a workspace reload** — the only way to keep
  the derived Applications/Libraries view correct after raw edits.
- **Tabs + active tab + expanded folders persisted in EditorState** — matches
  how `activeModulePath` already survives reloads; restores the session.
- **Binary files get a placeholder tab** — Monaco is for text only.

## Note on the existing structured view

The Applications/Libraries view is already parsed from the whole workspace
(`loadWorkspace` recursively scans every `telo.yaml`). No change is needed there
beyond hosting it inside the new module tabs.
