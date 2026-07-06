import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { CacheLookupResult, CacheStore } from "@telorun/cache";

interface StoreResource {
  metadata: { name: string; module?: string };
  maxEntries?: number;
}

interface Envelope {
  value: unknown;
  storedAt: number;
  freshUntil: number;
  expireAt: number;
}

/**
 * In-process cache store. Holds entries in a Map (insertion order = write
 * order, used for FIFO eviction) and classifies freshness against each entry's
 * fresh / stale windows on read.
 */
class MemoryStore implements ResourceInstance, CacheStore {
  private readonly entries = new Map<string, Envelope>();
  private readonly maxEntries: number;

  constructor(resource: StoreResource) {
    this.maxEntries = resource.maxEntries ?? 10000;
  }

  async get(key: string): Promise<CacheLookupResult> {
    const entry = this.entries.get(key);
    const now = Date.now();
    if (!entry || now >= entry.expireAt) {
      if (entry) this.entries.delete(key);
      return { state: "miss", value: null, age: null };
    }
    const state = now < entry.freshUntil ? "fresh" : "stale";
    return { state, value: entry.value, age: now - entry.storedAt };
  }

  async set(key: string, value: unknown, ttlMs: number, staleTtlMs: number): Promise<void> {
    const now = Date.now();
    // Re-insert at the tail so recency reflects the latest write.
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      storedAt: now,
      freshUntil: now + ttlMs,
      expireAt: now + ttlMs + staleTtlMs,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  // Atomic within the single-threaded event loop: no `await` between the read
  // and the write, so concurrent increments can't interleave. The expiry is set
  // only when the counter is first created this window (fixed window).
  async increment(key: string, delta: number, ttlMs: number): Promise<number> {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry || now >= entry.expireAt) {
      this.entries.delete(key);
      this.entries.set(key, { value: delta, storedAt: now, freshUntil: now + ttlMs, expireAt: now + ttlMs });
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
      return delta;
    }
    const next = (typeof entry.value === "number" ? entry.value : 0) + delta;
    entry.value = next;
    return next;
  }

  async provide(): Promise<MemoryStore> {
    return this;
  }

  async teardown(): Promise<void> {
    this.entries.clear();
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: StoreResource,
  _ctx: ResourceContext,
): Promise<MemoryStore> {
  return new MemoryStore(resource);
}
