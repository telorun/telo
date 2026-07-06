import type { ResourceContext, ResourceInstance } from "@telorun/sdk";

/** One journaled record: its monotonic id (1-based, gap-free per key) and data. */
export interface JournalEntry {
  id: number;
  data: unknown;
}

interface Buffer {
  entries: JournalEntry[];
  done: boolean;
  errored: boolean;
  error: unknown;
  waiters: Array<() => void>;
}

/**
 * An in-memory, keyed, offset-addressable replay buffer. A producer appends
 * records under a key (each getting a monotonic id) and marks the key finished
 * or failed; a consumer reads from any id and then tails live until the key is
 * done. This is what makes a detached stream resumable: a client that drops and
 * reconnects re-reads from its last seen id (an SSE `Last-Event-ID`), replaying
 * what it missed and then continuing live. Buffers are retained until `discard`.
 */
export class JournalStore implements ResourceInstance {
  private readonly buffers = new Map<string, Buffer>();

  private buffer(key: string): Buffer {
    let b = this.buffers.get(key);
    if (!b) {
      b = { entries: [], done: false, errored: false, error: null, waiters: [] };
      this.buffers.set(key, b);
    }
    return b;
  }

  private wake(b: Buffer): void {
    const waiters = b.waiters;
    b.waiters = [];
    for (const w of waiters) w();
  }

  /** Append a record under `key`; returns its assigned monotonic id. */
  append(key: string, data: unknown): number {
    const b = this.buffer(key);
    if (b.done) throw new Error(`RecordStream.Journal: key '${key}' is already finished; cannot append`);
    const id = b.entries.length === 0 ? 1 : b.entries[b.entries.length - 1].id + 1;
    b.entries.push({ id, data });
    this.wake(b);
    return id;
  }

  /** Mark `key` complete — readers past the tail then end normally. */
  finish(key: string): void {
    const b = this.buffer(key);
    b.done = true;
    this.wake(b);
  }

  /** Mark `key` failed — readers past the tail then throw `error`. Errors are
   *  surfaced to every attached reader, never swallowed. */
  fail(key: string, error: unknown): void {
    const b = this.buffer(key);
    b.done = true;
    b.errored = true;
    b.error = error;
    this.wake(b);
  }

  /** True once `key` has been finished or failed. */
  isDone(key: string): boolean {
    return this.buffers.get(key)?.done ?? false;
  }

  /** The last id appended under `key` (0 if none). */
  lastId(key: string): number {
    const b = this.buffers.get(key);
    return b && b.entries.length ? b.entries[b.entries.length - 1].id : 0;
  }

  /** Drop a key's buffer to free memory once no reader will resume it. */
  discard(key: string): void {
    this.buffers.delete(key);
  }

  /** Read entries with id > `fromId`, then tail live until `key` is done. */
  async *read(key: string, fromId: number): AsyncGenerator<JournalEntry> {
    const b = this.buffer(key);
    // Ids are gap-free and 1-based, so entries[i].id === i + 1 — an id maps
    // straight to an array index. Advancing the index (rather than rescanning
    // from the start on each wake) keeps a live tail linear, not quadratic.
    let i = fromId;
    while (true) {
      for (; i < b.entries.length; i++) {
        yield b.entries[i];
      }
      if (b.done) {
        if (b.errored) throw b.error instanceof Error ? b.error : new Error(String(b.error));
        return;
      }
      // Caught up on a live key — wait for the next append or terminal mark.
      await new Promise<void>((resolve) => b.waiters.push(resolve));
    }
  }

  async provide(): Promise<JournalStore> {
    return this;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

interface JournalRef {
  name: string;
  alias?: string;
}

function isJournalStore(value: unknown): value is JournalStore {
  return value instanceof JournalStore;
}

/**
 * Resolve a `journal` field to a live JournalStore — the Phase-5-injected
 * instance, or a `{ name, alias }` ref reached through an import's exported
 * scope. Mirrors `resolveShellHost` / `resolveCacheStore`.
 */
export function resolveJournal(
  value: JournalStore | JournalRef | undefined,
  ctx: ResourceContext,
): JournalStore {
  if (!value) throw new Error("RecordStream: 'journal' is required");
  if (isJournalStore(value)) return value;

  const ref = value as JournalRef;
  if (typeof ref.name !== "string") throw new Error("RecordStream: invalid journal reference");

  const instance =
    ref.alias && ref.alias !== "Self"
      ? ctx.moduleContext.resolveImportedInstance(ref.alias, ref.name)
      : ctx.moduleContext.getInstance(ref.name);
  if (!isJournalStore(instance)) {
    const label = ref.alias ? `${ref.alias}.${ref.name}` : ref.name;
    throw new Error(`RecordStream: journal reference '${label}' did not resolve to a Journal instance.`);
  }
  return instance;
}
