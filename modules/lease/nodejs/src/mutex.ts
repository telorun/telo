import type { CacheStore } from "@telorun/cache";

export interface AcquireResult {
  acquired: boolean;
  /** The current holder's token when not acquired (undefined if unknown). */
  holder?: unknown;
}

/**
 * A race-free, self-healing keyed mutex over a Cache.Store. The atomic gate is
 * `increment`: exactly one caller can bring the counter from 0 to 1, so exactly
 * one wins; losers undo their increment and read back the holder. The counter's
 * `ttlMs` expiry makes the lease self-healing — if a holder dies without
 * releasing, the lease frees on expiry. Release is holder-matched, so a stale
 * holder whose lease already expired (and was re-acquired by another) can't free
 * the new owner's lease.
 */
export class Mutex {
  constructor(
    private readonly store: CacheStore,
    private readonly name: string,
    private readonly ttlMs: number,
  ) {}

  private counterKey(key: string): string {
    return `lease:${this.name}:${key}`;
  }

  private holderKey(key: string): string {
    return `lease:${this.name}:${key}:holder`;
  }

  async acquire(key: string, holder: unknown): Promise<AcquireResult> {
    const n = await this.store.increment(this.counterKey(key), 1, this.ttlMs);
    if (n === 1) {
      await this.store.set(this.holderKey(key), holder, this.ttlMs, 0);
      return { acquired: true };
    }
    // Someone holds it — undo our over-count and report the current holder.
    await this.store.increment(this.counterKey(key), -1, this.ttlMs);
    const cur = await this.store.get(this.holderKey(key));
    return { acquired: false, holder: cur.state === "miss" ? undefined : cur.value };
  }

  async release(key: string, holder: unknown): Promise<void> {
    const cur = await this.store.get(this.holderKey(key));
    // Only release a lease we still hold. A miss means it already expired —
    // decrementing would seed a stray -1 counter and wedge the key until TTL.
    // A mismatch means another owner took it over on our expiry.
    if (cur.state === "miss" || cur.value !== holder) return;
    await this.store.increment(this.counterKey(key), -1, this.ttlMs);
    await this.store.delete(this.holderKey(key));
  }
}
