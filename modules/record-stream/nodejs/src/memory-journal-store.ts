import type { CancellationToken, ResourceInstance } from "@telorun/sdk";
import type {
  JournalPage,
  JournalScan,
  JournalStore,
  JournalStoreEntry,
  ScannedHeader,
} from "./journal-store-contract.js";

/** The longest delay a Node timer honours; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

interface Cell {
  value: string;
  version: string;
  writtenAt: number;
  entries: JournalStoreEntry[];
}

/**
 * The store held in one process's memory. Every operation runs to completion
 * without an `await`, so within the single-threaded event loop a conditional
 * write cannot interleave with another caller's — that is what makes each one
 * atomic here. Waiters are woken on every change to their key.
 */
class MemoryJournalStore implements JournalStore, ResourceInstance {
  private readonly cells = new Map<string, Cell>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private revision = 0;

  private write(key: string, cell: Cell | undefined): string | null {
    if (cell) this.cells.set(key, cell);
    else this.cells.delete(key);
    const listeners = this.waiters.get(key);
    if (listeners) {
      this.waiters.delete(key);
      for (const wake of listeners) wake();
    }
    return cell?.version ?? null;
  }

  private nextVersion(): string {
    return String(++this.revision);
  }

  private at(key: string, version: string): Cell | undefined {
    const cell = this.cells.get(key);
    return cell && cell.version === version ? cell : undefined;
  }

  async read(key: string, fromId: number, limit: number): Promise<JournalPage> {
    const cell = this.cells.get(key);
    if (!cell) return { header: null, entries: [] };
    // Ids are gap-free and 1-based, so an id maps straight to an index.
    return {
      header: { value: cell.value, version: cell.version, ageMs: Date.now() - cell.writtenAt },
      entries: cell.entries.slice(fromId, fromId + limit),
    };
  }

  async putIfAbsent(key: string, value: string): Promise<string | null> {
    if (this.cells.has(key)) return null;
    return this.write(key, { value, version: this.nextVersion(), writtenAt: Date.now(), entries: [] });
  }

  async compareAndSet(key: string, version: string, value: string): Promise<string | null> {
    const cell = this.at(key, version);
    if (!cell) return null;
    return this.write(key, { ...cell, value, version: this.nextVersion(), writtenAt: Date.now() });
  }

  async compareAndAppend(
    key: string,
    version: string,
    record: string,
  ): Promise<{ id: number; version: string } | null> {
    const cell = this.at(key, version);
    if (!cell) return null;
    const id = cell.entries.length + 1;
    cell.entries.push({ id, record });
    const next = this.write(key, { ...cell, version: this.nextVersion() })!;
    return { id, version: next };
  }

  async compareAndTruncate(key: string, version: string, value: string): Promise<string | null> {
    const cell = this.at(key, version);
    if (!cell) return null;
    return this.write(key, { value, version: this.nextVersion(), writtenAt: Date.now(), entries: [] });
  }

  async compareAndDelete(key: string, version: string): Promise<boolean> {
    if (!this.at(key, version)) return false;
    this.write(key, undefined);
    return true;
  }

  async scan(minAgeMs: number, cursor: string | null, limit: number): Promise<JournalScan> {
    const now = Date.now();
    const after = cursor === null ? null : (JSON.parse(cursor) as [number, string]);
    const eligible: Array<{ header: ScannedHeader; writtenAt: number }> = [];
    for (const [key, cell] of this.cells) {
      const ageMs = now - cell.writtenAt;
      if (ageMs < minAgeMs) continue;
      if (after && (cell.writtenAt < after[0] || (cell.writtenAt === after[0] && key <= after[1]))) continue;
      eligible.push({ header: { key, value: cell.value, version: cell.version, ageMs }, writtenAt: cell.writtenAt });
    }
    eligible.sort(
      (a, b) =>
        a.writtenAt - b.writtenAt || (a.header.key < b.header.key ? -1 : a.header.key > b.header.key ? 1 : 0),
    );
    const page = eligible.slice(0, limit);
    const last = page[page.length - 1];
    return {
      headers: page.map((item) => item.header),
      cursor: eligible.length > limit && last ? JSON.stringify([last.writtenAt, last.header.key]) : null,
    };
  }

  wait(key: string, version: string | null, timeoutMs: number, cancellation: CancellationToken): Promise<void> {
    if (cancellation.isCancelled || (this.cells.get(key)?.version ?? null) !== version) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let listeners = this.waiters.get(key);
      if (!listeners) {
        listeners = new Set();
        this.waiters.set(key, listeners);
      }
      const wake = () => {
        clearTimeout(timer);
        unsubscribe();
        const current = this.waiters.get(key);
        if (current) {
          current.delete(wake);
          if (current.size === 0) this.waiters.delete(key);
        }
        resolve();
      };
      // A wait longer than a Node timer can hold ends at its limit; the caller re-waits.
      const timer = setTimeout(wake, Math.min(Math.max(0, timeoutMs), MAX_TIMER_MS));
      listeners.add(wake);
      const unsubscribe = cancellation.onCancelled(wake);
    });
  }

  async provide(): Promise<MemoryJournalStore> {
    return this;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(): Promise<MemoryJournalStore> {
  return new MemoryJournalStore();
}
