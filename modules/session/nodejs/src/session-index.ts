import { InvokeError } from "@telorun/sdk";
import type { KvStore } from "@telorun/kv-store";
import type { IndexEntry, IndexRecord } from "./session-records.js";

export const ERR_SESSION_CONTENDED = "ERR_SESSION_CONTENDED";

/** How many times a conditional write that lost a race is re-applied before the call gives up. */
export const MAX_REAPPLIES = 8;

/** How long a record outlives its deadline in the store, so a refusal can say "expired" instead of "unknown". */
export const RETENTION_MS = 60_000;

export interface IndexChange<R> {
  /** The entries to store; null leaves the index as it is. */
  readonly next: IndexEntry[] | null;
  readonly result: R;
}

/**
 * Applies `change` to the subject's index with one conditional write, reading the
 * index again and re-applying when a concurrent writer won. An empty result deletes
 * the index. Gives up with `ERR_SESSION_CONTENDED` after `MAX_REAPPLIES` losses.
 */
export async function updateIndex<R>(
  store: KvStore,
  key: string,
  describe: string,
  clock: () => number,
  change: (entries: readonly IndexEntry[], now: number) => IndexChange<R>,
): Promise<R> {
  for (let attempt = 0; attempt < MAX_REAPPLIES; attempt++) {
    const current = await store.get(key);
    const now = clock();
    const entries = (current?.value as IndexRecord | undefined)?.entries ?? [];
    const { next, result } = change(entries, now);
    if (next === null) return result;

    if (next.length === 0) {
      if (current === null) return result;
      if (await store.compareAndDelete(key, current.version)) return result;
      continue;
    }
    const ttlMs = Math.max(...next.map((entry) => entry.expiresAt)) - now + RETENTION_MS;
    const value: IndexRecord = { entries: next };
    const written =
      current === null
        ? await store.putIfAbsent(key, value, ttlMs)
        : await store.compareAndSet(key, current.version, value, ttlMs);
    if (written !== null) return result;
  }
  throw new InvokeError(
    ERR_SESSION_CONTENDED,
    `${describe}: the subject's session index kept changing under ${MAX_REAPPLIES} attempts to update it; repeat the call.`,
  );
}
