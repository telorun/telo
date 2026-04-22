/** One recorded edit: the file that was written, the text before the edit,
 *  and the text after. Stored pair-wise so undo and redo are symmetric and
 *  self-contained — each snapshot holds everything needed to jump in either
 *  direction without reading neighbouring entries. */
export interface Snapshot {
  filePath: string;
  before: string;
  after: string;
  timestamp: number;
}

/** Linear undo/redo stack for one module. `cursor` points at the next redo
 *  target: `snapshots[cursor - 1]` is the last applied edit (undo target);
 *  `snapshots[cursor]` is the next forward edit (redo target). A new edit
 *  truncates the redo tail (standard undo semantics). */
export interface ModuleHistory {
  snapshots: Snapshot[];
  cursor: number;
}

/** Keyed by the module's owner file path (canonical). */
export type HistoryState = Record<string, ModuleHistory>;

export interface HistoryStore {
  load(): HistoryState;
  save(state: HistoryState): void;
  clear(): void;
}

const KEY_PREFIX = "telo-editor-history-v1";

/** localStorage-backed store, one entry per workspace root. Kept separate from
 *  the UI-focus persisted state and the deployments store so each can evolve
 *  independently without forcing migrations on unrelated data. */
export class LocalStorageHistoryStore implements HistoryStore {
  constructor(public readonly rootDir: string) {}

  private get key(): string {
    return `${KEY_PREFIX}:${this.rootDir}`;
  }

  load(): HistoryState {
    if (typeof window === "undefined") return {};
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as HistoryState;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  save(state: HistoryState): void {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(this.key, JSON.stringify(state));
      return;
    } catch (err) {
      if (!isQuotaError(err)) return;
    }
    // Quota hit — evict the module whose most-recent snapshot is oldest and
    // retry once. Mutates the caller's state object so the in-memory manager
    // stays consistent with what's persisted; without this, every subsequent
    // save would silently fail and drift further from disk.
    const pruned = evictOldestModule(state);
    if (!pruned) return;
    try {
      localStorage.setItem(this.key, JSON.stringify(state));
    } catch {
      // Still failing — give up. The manager's in-memory state is now
      // out of sync with storage for this session, but further evictions
      // are unlikely to help and we don't want an unbounded retry loop.
    }
  }

  clear(): void {
    if (typeof window === "undefined") return;
    try {
      localStorage.removeItem(this.key);
    } catch {
      // ignore
    }
  }
}

/** Browsers throw different subclasses of `DOMException` for quota exhaustion
 *  (`QuotaExceededError`, legacy Firefox `NS_ERROR_DOM_QUOTA_REACHED`, code 22
 *  or legacy 1014). Match all three to avoid eating unrelated errors. */
function isQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: number }).code;
  if (code === 22 || code === 1014) return true;
  return err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED";
}

/** Removes the module whose most-recent snapshot is oldest. Returns true if
 *  something was dropped. Modules without snapshots are considered
 *  infinitely-old (timestamp 0) and evicted first; empty histories are cheap
 *  to drop and shouldn't be kept across sessions anyway. */
function evictOldestModule(state: HistoryState): boolean {
  let oldestKey: string | null = null;
  let oldestTs = Infinity;
  for (const [modPath, entry] of Object.entries(state)) {
    const last = entry.snapshots[entry.snapshots.length - 1];
    const ts = last?.timestamp ?? 0;
    if (ts < oldestTs) {
      oldestTs = ts;
      oldestKey = modPath;
    }
  }
  if (!oldestKey) return false;
  delete state[oldestKey];
  return true;
}
