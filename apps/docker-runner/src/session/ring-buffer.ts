import type { RunEvent } from "../types.js";

export interface BufferedEvent {
  id: number;
  event: RunEvent;
  bytes: number;
}

/**
 * Byte-capped FIFO ring buffer for SSE replay. Each entry tracks its
 * serialized byte size; when a new entry would push total bytes past the cap,
 * oldest entries are evicted until it fits. Entries are never split.
 *
 * Ids are assigned monotonically starting at 1 — never reused, never reset.
 * A client's `Last-Event-ID: <n>` asks for events with id > n; if the oldest
 * remaining id is still > n+1, the gap must be signaled separately.
 */
export class EventRingBuffer {
  private readonly entries: BufferedEvent[] = [];
  private totalBytes = 0;
  private nextId = 1;

  constructor(private readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error(`EventRingBuffer maxBytes must be a positive integer, got ${maxBytes}`);
    }
  }

  push(event: RunEvent): BufferedEvent {
    const id = this.nextId++;
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    const entry: BufferedEvent = { id, event, bytes };
    this.entries.push(entry);
    this.totalBytes += bytes;
    this.evict();
    return entry;
  }

  private evict(): void {
    // Invariant: always retain at least the most-recently-pushed entry, even
    // if it alone exceeds maxBytes. A single oversized event (a huge log
    // chunk) is still more useful to a reconnecting client than an empty
    // buffer, and the alternative (drop-and-gap) would surface as a spurious
    // "earlier output truncated" banner immediately after a big write.
    while (this.totalBytes > this.maxBytes && this.entries.length > 1) {
      const dropped = this.entries.shift();
      if (!dropped) break;
      this.totalBytes -= dropped.bytes;
    }
  }

  /**
   * Returns entries with id > afterId, in insertion order.
   * If `hasGap` is true, the caller should emit a `gap` marker before replay
   * because events between afterId+1 and the first returned id have been evicted.
   */
  replay(afterId: number): { entries: BufferedEvent[]; hasGap: boolean } {
    const entries = this.entries.filter((e) => e.id > afterId);
    const oldestId = this.entries[0]?.id ?? this.nextId;
    const hasGap = afterId + 1 < oldestId;
    return { entries, hasGap };
  }

  get size(): number {
    return this.entries.length;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get latestId(): number {
    return this.nextId - 1;
  }
}
