import { KeyedClaim, type KvStore } from "@telorun/kv-store";

export interface AcquireResult {
  acquired: boolean;
  /** The current holder's token when not acquired (undefined if unknown). */
  holder?: unknown;
  /** The revision of the claim this call took — the guard `release` must present
   *  so a holder whose lease already lapsed cannot free its successor's. */
  version?: string;
}

/**
 * A race-free, self-healing keyed mutex over a `KvStore.Store`.
 *
 * The atomic gate is a single conditional write (`putIfAbsent`, via `KeyedClaim`):
 * exactly one caller takes a free key and every other is told who holds it, with
 * no read-then-write gap. This replaced a `Cache.Store` implementation that
 * emulated the gate with a counter plus a separate holder key over a store which
 * is evictable by design — an evicted lease record meant two holders could run the
 * body, exactly the failure a lease exists to prevent.
 *
 * The TTL keeps the lease self-healing: a holder that dies without releasing frees
 * the key when its claim lapses. Release is revision-guarded, so a stale holder
 * whose lease already expired (and was re-acquired) cannot free the new owner's.
 */
export class Mutex {
  private readonly claims: KeyedClaim;

  constructor(
    store: KvStore,
    private readonly name: string,
    private readonly ttlMs: number,
  ) {
    this.claims = new KeyedClaim(store);
  }

  /** Namespaced so leases from different resources — and other consumers of a
   *  shared store, e.g. Idempotency.Once — never collide on a key. */
  private leaseKey(key: string): string {
    return `lease:${this.name}:${key}`;
  }

  async acquire(key: string, holder: string): Promise<AcquireResult> {
    const claim = await this.claims.claim(this.leaseKey(key), holder, this.ttlMs);
    if (claim.state === "new") return { acquired: true, version: claim.version };
    if (claim.state === "settled") {
      // A lease never settles, and its keys are namespaced, so this is
      // unreachable through lease traffic — it means something else wrote a
      // terminal record under a lease key. Returning `acquired: false` would
      // report a permanent, holder-less denial for the whole retention window
      // with nothing to diagnose from; raising names the cause instead.
      throw new Error(
        `Lease "${this.name}": key "${key}" holds a SETTLED record, which a lease never writes. ` +
          `Another consumer of this KvStore.Store is using a colliding key — give it its own ` +
          `store, or a key space that cannot overlap "lease:${this.name}:".`,
      );
    }
    return { acquired: false, holder: claim.holder };
  }

  async release(key: string, version: string): Promise<void> {
    await this.claims.release(this.leaseKey(key), version);
  }
}
