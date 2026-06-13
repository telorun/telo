import { createHash } from "crypto";

export interface Blob {
  bytes: Uint8Array;
  mediaType: string;
}

/**
 * In-memory, content-addressed blob store for debug binary payloads. The debug
 * serializer offloads every `Uint8Array` here and emits a small pointer in the
 * event log instead of the bytes; the `DebugServer` serves them at `/blobs/:id`
 * on demand. Content addressing (sha1 of the bytes) deduplicates — a redraw loop
 * that emits the same image every turn stores it once.
 *
 * Bounded by a total-byte LRU so a long session of large payloads can't grow
 * without limit; evicted blobs 404 (the event log keeps the pointer + metadata,
 * so the UI still shows *what* it was). Both `put` and `get` refresh recency, so
 * a blob you're actively viewing stays resident.
 */
export class LruBlobStore {
  private readonly map = new Map<string, Blob>(); // insertion order = LRU order
  private totalBytes = 0;

  constructor(private readonly maxBytes = 100 * 1024 * 1024) {}

  /** Store `bytes`, returning a stable content id. Idempotent for equal bytes. */
  put(bytes: Uint8Array, mediaType: string): string {
    const id = createHash("sha1").update(bytes).digest("hex").slice(0, 16);
    const existing = this.map.get(id);
    if (existing) {
      this.touch(id, existing);
      return id;
    }
    this.map.set(id, { bytes, mediaType });
    this.totalBytes += bytes.byteLength;
    this.evict();
    return id;
  }

  get(id: string): Blob | undefined {
    const blob = this.map.get(id);
    if (blob) this.touch(id, blob);
    return blob;
  }

  private touch(id: string, blob: Blob): void {
    this.map.delete(id);
    this.map.set(id, blob);
  }

  private evict(): void {
    while (this.totalBytes > this.maxBytes && this.map.size > 1) {
      const oldest = this.map.keys().next().value as string;
      const blob = this.map.get(oldest)!;
      this.map.delete(oldest);
      this.totalBytes -= blob.bytes.byteLength;
    }
  }
}
