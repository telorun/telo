import { InvokeError, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import type { KvStore, VersionedValue } from "@telorun/kv-store";
import { randomUUID } from "node:crypto";

interface StoreResource {
  metadata: { name: string; module?: string };
  maxEntries?: number;
}

interface Cell {
  value: unknown;
  version: string;
  expiresAt: number;
}

/**
 * In-process durable store.
 *
 * Every operation runs to completion without an `await`, so within the
 * single-threaded event loop a read-then-write cannot interleave with another
 * caller's — that is what makes the conditional writes atomic here, the same way
 * `SET NX` or a SQL unique key does remotely.
 *
 * Records are never evicted under pressure: surviving the full TTL is the
 * guarantee this store exists to provide. Overflow is an error, not a quiet drop.
 */
class MemoryKvStore implements ResourceInstance, KvStore {
  private readonly cells = new Map<string, Cell>();
  private readonly maxEntries: number;

  constructor(private readonly resource: StoreResource) {
    this.maxEntries = resource.maxEntries ?? 100000;
  }

  /** A lapsed record is logically absent — drop it so the key reads as free. */
  private live(key: string): Cell | undefined {
    const cell = this.cells.get(key);
    if (!cell) return undefined;
    if (Date.now() >= cell.expiresAt) {
      this.cells.delete(key);
      return undefined;
    }
    return cell;
  }

  private write(key: string, value: unknown, ttlMs: number): VersionedValue {
    const version = randomUUID();
    this.cells.set(key, { value, version, expiresAt: Date.now() + ttlMs });
    return { value, version };
  }

  async get(key: string): Promise<VersionedValue | null> {
    const cell = this.live(key);
    return cell ? { value: cell.value, version: cell.version } : null;
  }

  async putIfAbsent(key: string, value: unknown, ttlMs: number): Promise<VersionedValue | null> {
    if (this.live(key)) return null;

    if (this.cells.size >= this.maxEntries) {
      throw new InvokeError(
        "ERR_STORE_FULL",
        `KvStoreMemory.Store "${this.resource.metadata.name}" reached maxEntries ` +
          `(${this.maxEntries}). Records are never evicted — dropping one would permit work to ` +
          `happen twice — so raise \`maxEntries\`, shorten the TTLs, or move to a durable ` +
          `backend (kv-store-sql / kv-store-redis).`,
      );
    }
    return this.write(key, value, ttlMs);
  }

  async compareAndSet(
    key: string,
    expectedVersion: string,
    value: unknown,
    ttlMs: number,
  ): Promise<VersionedValue | null> {
    const cell = this.live(key);
    if (!cell || cell.version !== expectedVersion) return null;
    return this.write(key, value, ttlMs);
  }

  async compareAndDelete(key: string, expectedVersion: string): Promise<boolean> {
    const cell = this.live(key);
    if (!cell || cell.version !== expectedVersion) return false;
    this.cells.delete(key);
    return true;
  }

  async provide(): Promise<MemoryKvStore> {
    return this;
  }

  async teardown(): Promise<void> {
    this.cells.clear();
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export const store = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: StoreResource, _ctx: ResourceContext) {
    return new MemoryKvStore(resource);
  },
};
