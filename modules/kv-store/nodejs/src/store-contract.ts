/**
 * `KvStore.Store` — a durable, non-evicting key/value store with atomic
 * conditional writes.
 *
 * This is deliberately *storage*, not a protocol. An earlier shape exposed
 * `claim`/`renew`/`settle`/`release` directly, which pushed one state machine into
 * every backend: the same ownership guard ended up written three times — in
 * JavaScript, in SQL `WHERE` clauses, and in Lua. Four primitives instead mean a
 * backend implements only what its engine already does natively, and the state
 * machine lives once, in `KeyedClaim`.
 *
 * What separates this from `Cache.Store` — also a key/value store — is not the
 * operations but the **guarantees**:
 *
 *  - **Non-evicting.** A record survives until its TTL lapses; it is never dropped
 *    for memory pressure. A cache may discard anything, and a discarded record
 *    here means work happens twice.
 *  - **Atomic conditional writes.** `putIfAbsent` and `compareAndSet` are each ONE
 *    operation at the backend, atomic across every process sharing it. A
 *    read-then-write from the client does not implement either.
 *
 * A backend that cannot meet both must not implement this abstract.
 */

/** A record plus the opaque token identifying this exact revision of it. Pass the
 *  token back to a conditional write to mean "only if nothing changed since". */
export interface VersionedValue {
  value: unknown;
  /** Opaque and store-generated. Never parse it, never order by it. */
  version: string;
}

export interface KvStore {
  /** Current record, or null when the key is absent or its TTL has lapsed. */
  get(key: string): Promise<VersionedValue | null>;

  /**
   * Write only if the key is free — absent, or holding a lapsed record. Returns
   * the new revision on success, or `null` when someone else holds it. Losing is
   * an outcome, not an error: a caller learns it lost without an exception.
   */
  putIfAbsent(key: string, value: unknown, ttlMs: number): Promise<VersionedValue | null>;

  /**
   * Replace the record only if it is still at `expectedVersion`, refreshing its
   * TTL. Returns the new revision, or `null` when the version no longer matches —
   * someone else wrote, or the record lapsed.
   *
   * This is also how a holder extends a TTL: compare-and-set the same value.
   */
  compareAndSet(
    key: string,
    expectedVersion: string,
    value: unknown,
    ttlMs: number,
  ): Promise<VersionedValue | null>;

  /** Delete only if the record is still at `expectedVersion`. */
  compareAndDelete(key: string, expectedVersion: string): Promise<boolean>;
}
