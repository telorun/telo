import type { HistoryState, HistoryStore, ModuleHistory, Snapshot } from "./store";

const MAX_ENTRIES_PER_MODULE = 20;
const COALESCE_MS = 1000;

/** In-memory owner of per-module undo/redo stacks. Reads initial state from
 *  the provided store and writes back on every mutation; the store decides
 *  where that state lives (localStorage in v1, file system later).
 *
 *  Module paths are treated as canonical keys — callers are responsible for
 *  passing a `normalizePath`-ed value. Snapshots' `filePath` fields should
 *  likewise be canonical so pruning by "known files" is accurate. */
export class HistoryManager {
  private state: HistoryState;
  private readonly cap: number;

  constructor(
    private readonly store: HistoryStore,
    public readonly rootDir: string,
    cap: number = MAX_ENTRIES_PER_MODULE,
  ) {
    this.state = store.load();
    this.cap = cap;
  }

  /** Records one persisted file-write as the newest entry in a module's
   *  stack. Coalesces with the previous entry when same-file and within
   *  COALESCE_MS — under coalescing the stored `before` is kept (earliest
   *  state in the run) and only `after` advances, so a slider drag still
   *  undoes to the state *before* the drag started rather than to the
   *  intermediate frame. */
  recordEdit(modulePath: string, snap: Snapshot): void {
    const entry = this.getOrCreate(modulePath);
    entry.snapshots = entry.snapshots.slice(0, entry.cursor);

    const last = entry.snapshots[entry.snapshots.length - 1];
    if (
      last &&
      last.filePath === snap.filePath &&
      snap.timestamp - last.timestamp < COALESCE_MS
    ) {
      last.after = snap.after;
    } else {
      entry.snapshots.push(snap);
    }

    if (entry.snapshots.length > this.cap) {
      entry.snapshots = entry.snapshots.slice(entry.snapshots.length - this.cap);
    }
    entry.cursor = entry.snapshots.length;
    this.state[modulePath] = entry;
    this.store.save(this.state);
  }

  /** Advances the cursor backwards and returns the snapshot to apply. Caller
   *  is expected to write `snap.before` to `snap.filePath`. Returns null when
   *  there is nothing to undo. */
  undo(modulePath: string): Snapshot | null {
    const entry = this.state[modulePath];
    if (!entry || entry.cursor <= 0) return null;
    entry.cursor -= 1;
    const snap = entry.snapshots[entry.cursor];
    this.store.save(this.state);
    return snap;
  }

  /** Advances the cursor forwards and returns the snapshot to apply. Caller
   *  is expected to write `snap.after` to `snap.filePath`. Returns null when
   *  there is nothing to redo. */
  redo(modulePath: string): Snapshot | null {
    const entry = this.state[modulePath];
    if (!entry || entry.cursor >= entry.snapshots.length) return null;
    const snap = entry.snapshots[entry.cursor];
    entry.cursor += 1;
    this.store.save(this.state);
    return snap;
  }

  canUndo(modulePath: string): boolean {
    const entry = this.state[modulePath];
    return !!entry && entry.cursor > 0;
  }

  canRedo(modulePath: string): boolean {
    const entry = this.state[modulePath];
    return !!entry && entry.cursor < entry.snapshots.length;
  }

  peekUndo(modulePath: string): Snapshot | null {
    const entry = this.state[modulePath];
    if (!entry || entry.cursor <= 0) return null;
    return entry.snapshots[entry.cursor - 1];
  }

  peekRedo(modulePath: string): Snapshot | null {
    const entry = this.state[modulePath];
    if (!entry || entry.cursor >= entry.snapshots.length) return null;
    return entry.snapshots[entry.cursor];
  }

  /** Drops entries for modules not in `knownModulePaths`. Call after a
   *  workspace load to discard history for modules that have been deleted
   *  or renamed since the last session. */
  pruneStaleModules(knownModulePaths: Set<string>): void {
    let changed = false;
    for (const modPath of Object.keys(this.state)) {
      if (!knownModulePaths.has(modPath)) {
        delete this.state[modPath];
        changed = true;
      }
    }
    if (changed) this.store.save(this.state);
  }

  /** Drops snapshots whose `filePath` is no longer part of the module.
   *  Clamps the cursor so it stays a valid index into the pruned array. */
  pruneStaleSnapshots(modulePath: string, knownFilePaths: Set<string>): void {
    const entry = this.state[modulePath];
    if (!entry) return;
    const kept = entry.snapshots.filter((s) => knownFilePaths.has(s.filePath));
    if (kept.length === entry.snapshots.length) return;
    entry.snapshots = kept;
    if (entry.cursor > kept.length) entry.cursor = kept.length;
    this.store.save(this.state);
  }

  private getOrCreate(modulePath: string): ModuleHistory {
    const existing = this.state[modulePath];
    if (existing) return existing;
    const fresh: ModuleHistory = { snapshots: [], cursor: 0 };
    this.state[modulePath] = fresh;
    return fresh;
  }
}
