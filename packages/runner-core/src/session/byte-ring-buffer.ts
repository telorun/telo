export interface BufferedBytes {
  seq: number;
  bytes: Buffer;
}

/**
 * Byte-capped FIFO ring buffer for raw PTY output replay. Mirrors
 * EventRingBuffer's eviction-with-gap semantics but stores Buffer slices keyed
 * by a monotonic seq number — never reused, never reset.
 *
 * A client's `?lastSeq=<n>` asks for chunks with seq > n; if the oldest
 * remaining seq is still > n+1, the gap must be signaled separately.
 */
export class ByteRingBuffer {
  private readonly entries: BufferedBytes[] = [];
  private totalBytes = 0;
  private nextSeq = 1;

  constructor(private readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error(`ByteRingBuffer maxBytes must be a positive integer, got ${maxBytes}`);
    }
  }

  push(bytes: Buffer): BufferedBytes {
    const seq = this.nextSeq++;
    const entry: BufferedBytes = { seq, bytes };
    this.entries.push(entry);
    this.totalBytes += bytes.byteLength;
    this.evict();
    return entry;
  }

  private evict(): void {
    // Always retain at least the most-recent entry, even if it alone exceeds
    // maxBytes — same invariant as EventRingBuffer.
    while (this.totalBytes > this.maxBytes && this.entries.length > 1) {
      const dropped = this.entries.shift();
      if (!dropped) break;
      this.totalBytes -= dropped.bytes.byteLength;
    }
  }

  replay(afterSeq: number): { entries: BufferedBytes[]; hasGap: boolean } {
    const entries = this.entries.filter((e) => e.seq > afterSeq);
    const oldestSeq = this.entries[0]?.seq ?? this.nextSeq;
    const hasGap = afterSeq + 1 < oldestSeq;
    return { entries, hasGap };
  }

  get size(): number {
    return this.entries.length;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get latestSeq(): number {
    return this.nextSeq - 1;
  }
}
