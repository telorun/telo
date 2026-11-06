import { InvokeError, isCancellationError, isSuspension } from "@telorun/sdk";
import type { KvStore, VersionedValue } from "@telorun/kv-store";

export const ERR_SESSION_STORE_UNAVAILABLE = "ERR_SESSION_STORE_UNAVAILABLE";
/** Terminal: the store answered in a way a key/value store cannot. */
export const ERR_SESSION_STORE_INCONSISTENT = "ERR_SESSION_STORE_INCONSISTENT";

/**
 * The one place sessions reach the store. A cancellation and a durable
 * suspension pass through unchanged; any other failure is the storage's own,
 * raised as `ERR_SESSION_STORE_UNAVAILABLE` with the thrown value as its cause.
 */
export class GuardedStore implements KvStore {
  constructor(
    private readonly store: KvStore,
    private readonly describe: string,
  ) {}

  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (isCancellationError(err) || isSuspension(err)) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new InvokeError(
        ERR_SESSION_STORE_UNAVAILABLE,
        `${this.describe}: the session store failed — ${reason}`,
        undefined,
        { cause: err },
      );
    }
  }

  get(key: string): Promise<VersionedValue | null> {
    return this.guard(() => this.store.get(key));
  }

  putIfAbsent(key: string, value: unknown, ttlMs: number): Promise<VersionedValue | null> {
    return this.guard(() => this.store.putIfAbsent(key, value, ttlMs));
  }

  compareAndSet(key: string, expectedVersion: string, value: unknown, ttlMs: number): Promise<VersionedValue | null> {
    return this.guard(() => this.store.compareAndSet(key, expectedVersion, value, ttlMs));
  }

  compareAndDelete(key: string, expectedVersion: string): Promise<boolean> {
    return this.guard(() => this.store.compareAndDelete(key, expectedVersion));
  }
}

export function storeInconsistent(describe: string, what: string): InvokeError {
  return new InvokeError(
    ERR_SESSION_STORE_INCONSISTENT,
    `${describe}: ${what}, which a key/value store cannot do; the storage needs attention.`,
  );
}
