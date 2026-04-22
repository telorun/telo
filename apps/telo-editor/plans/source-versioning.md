# Source Versioning (Undo/Redo per Module)

## Goal

Every edit in the telo editor produces a new version of the edited module source. Users can undo and redo across edits via toolbar buttons, regardless of whether the edit came from a form field, the topology canvas, or the Monaco source view.

## Scope

- **One history stack per module**, keyed by the module's owner file path (the `telo.yaml` that declares `Telo.Application` / `Telo.Library`).
- History covers all files belonging to a module: the owner and any `include:` partials.
- Cap: 20 entries per module, ring-buffer (drop oldest when full).
- Linear history with a cursor. Redo is available after undo until the next new edit, at which point the redo tail is truncated.
- **Monaco's built-in undo stays as-is** (editor-local, in-buffer). We do not hook into it. Our history only tracks committed writes.

## Non-goals

- No keybindings in v1. Toolbar buttons only.
- No branching history / git-like DAG.
- No diff view or history panel UI (can be added later; stack is inspectable).
- No cross-module undo (each module has its own independent stack).

## Data model

```ts
interface Snapshot {
  filePath: string;     // canonical path of the file whose text is captured
  text: string;         // the file's YAML text *before* the edit
  timestamp: number;    // ms since epoch
}

interface ModuleHistory {
  snapshots: Snapshot[];
  cursor: number;       // index of the next snapshot to redo; snapshots[cursor-1] is the latest undo target
}

// Keyed by module owner filePath
type HistoryState = Record<string, ModuleHistory>;
```

A snapshot is *pre-edit state* for one file. Undo = write `snapshots[cursor-1].text` back to its `filePath`, decrement cursor. Redo = write the current text forward, increment cursor. (Symmetry requires redo to capture the present state before jumping forward — see "Undo/redo semantics" below.)

## Storage adapter

```ts
interface HistoryStore {
  load(): HistoryState;
  save(state: HistoryState): void;
  clear(): void;
}
```

First implementation: `LocalStorageHistoryStore`, keyed by `telo-editor:history:<workspaceRoot>` so multiple workspaces don't collide. Future adapters (`.telo/history/` on disk, IndexedDB) drop in without touching history-manager logic.

## Hook point

All persistence flows through `persistModule()` in [Editor.tsx](../src/Editor.tsx), which calls `saveModuleFromDocuments()` in [loader/crud.ts](../src/loader/crud.ts). This is the single chokepoint for both form edits and debounced Monaco commits.

Wrap `persistModule()` so that immediately before it writes:

1. Resolve the owning module for the file being saved (via `Workspace.documents` → owner file).
2. Read the current on-disk / in-memory `document.text` for that file (the *pre-edit* text).
3. Push `{ filePath, text, timestamp: Date.now() }` onto the module's stack.
4. Apply coalescing (see below).
5. Truncate `snapshots` after `cursor` (drop any redo tail).
6. Enforce the 20-entry cap (drop oldest).
7. Advance `cursor` to `snapshots.length`.
8. Persist via `HistoryStore.save()`.
9. Continue with the normal write.

## Coalescing

Consecutive edits to the same `filePath` within **1000 ms** of the previous snapshot collapse into the existing entry (do not push a new one, do not update the timestamp). This prevents a slider or rapid typing from burning the 20-slot cap.

Coalescing never crosses file boundaries: editing file A then file B within 1s produces two snapshots.

## Undo / redo semantics

Two buttons in the editor toolbar, enabled/disabled based on the active module's history:

- **Undo** (enabled when `cursor > 0`):
  1. Capture the *current* text of `snapshots[cursor-1].filePath` into a forward snapshot (so redo can return to it).
  2. Write `snapshots[cursor-1].text` back to disk via the normal `saveModuleFromDocuments()` path.
  3. Re-parse via `parseModuleDocument()` and update `Workspace.documents` + `modules`.
  4. Decrement `cursor`.
- **Redo** (enabled when `cursor < snapshots.length`):
  1. Symmetric: write `snapshots[cursor].text` back; increment `cursor`.

The forward snapshot during undo is required so the stack round-trips correctly. Implementation choice: either (a) store both pre- and post-edit text per snapshot, or (b) capture the current file text lazily during undo and stash it at `snapshots[cursor]`. (b) keeps snapshots lean and is recommended.

An edit performed while `cursor < snapshots.length` (i.e. the user undid something and then made a new change) truncates the redo tail before pushing, as in any standard undo stack.

## UI

- Two icon buttons (lucide `Undo2`, `Redo2`) in the editor toolbar.
- Disabled state when no history is available for the active module.
- Tooltip shows the timestamp of the target snapshot (e.g. "Undo edit from 14:32:05").

No keybindings in v1. (Ctrl-Z inside Monaco continues to do Monaco's in-buffer undo; that's fine and orthogonal.)

## Edge cases

- **Module has no history yet**: both buttons disabled.
- **Active module switched**: buttons reflect the new module's stack.
- **File deleted externally / renamed**: if a snapshot's `filePath` no longer exists on undo, surface a toast error and drop the snapshot. Do not crash.
- **Workspace reload**: `LocalStorageHistoryStore.load()` restores state on startup. Stale entries (files that no longer exist) are pruned on load.
- **Partial files added/removed via include changes**: a snapshot referencing a file no longer in the module is treated as above (prune on access).
- **Large text**: at ~100 KB per file × 20 snapshots × N modules, localStorage headroom is the risk. Per-module eviction at 20 is the first line of defence. If we hit localStorage quota, drop oldest module's history wholesale.

## Implementation steps

1. Add `HistoryStore` interface + `LocalStorageHistoryStore` under `apps/telo-editor/src/history/`.
2. Add a `HistoryManager` class (or hook) that owns the in-memory `HistoryState`, wraps push/undo/redo, and writes through to the store.
3. Instantiate the manager alongside the workspace in [Editor.tsx](../src/Editor.tsx); load state on mount.
4. Wrap `persistModule()` to call `historyManager.recordEdit(filePath, previousText)` before `saveModuleFromDocuments()`.
5. Add undo/redo toolbar buttons; wire to `historyManager.undo(activeModule)` / `.redo(activeModule)`. Both actions ultimately route through `saveModuleFromDocuments()` + `parseModuleDocument()` to keep the workspace in sync.
6. Disable buttons based on `historyManager.canUndo(activeModule)` / `.canRedo(activeModule)`.
7. Prune stale snapshots on load and on access.

## Effort estimate

~2 days: ~0.5 for the store + manager, ~0.5 for the persist wrap and coalescing, ~0.5 for UI + wiring, ~0.5 for edge cases and manual testing across form + source views.

## Out of scope / future

- Keybindings (Ctrl-Z / Ctrl-Shift-Z outside Monaco).
- History panel with timestamped list and jump-to.
- On-disk adapter (`.telo/history/`) for durability across machines.
- Cross-module "global undo" timeline.
- Branching history.
- Diff preview on hover.
