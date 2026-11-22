import { InvokeError, isCancellationError, isSuspension } from "@telorun/sdk";
import type { KvStore, VersionedValue } from "@telorun/kv-store";

export const ERR_ONE_TIME_STORE_UNAVAILABLE = "ERR_ONE_TIME_STORE_UNAVAILABLE";
export const ERR_ONE_TIME_CONTENDED = "ERR_ONE_TIME_CONTENDED";

/**
 * The one place token sets reach the store. A cancellation and a durable
 * suspension pass through unchanged; any other failure is the storage's own,
 * raised as `ERR_ONE_TIME_STORE_UNAVAILABLE` with the thrown value as its cause.
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
        ERR_ONE_TIME_STORE_UNAVAILABLE,
        `${this.describe}: the token store failed — ${reason}`,
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

export function contended(describe: string, what: string): InvokeError {
  return new InvokeError(
    ERR_ONE_TIME_CONTENDED,
    `${describe}: ${what} kept losing races to concurrent writes. Repeat the call.`,
  );
}
