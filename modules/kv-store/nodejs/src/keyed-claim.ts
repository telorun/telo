import { randomUUID } from "node:crypto";
import type { KvStore } from "./store-contract.js";

/** `new` — this caller now owns the key. `held` — someone else owns it (their
 *  token is in `holder`). `settled` — terminal, `value` is the retained result. */
export type ClaimState = "new" | "held" | "settled";

export interface ClaimResult {
  state: ClaimState;
  /** The owning token on `held`; absent otherwise. */
  holder?: string;
  /** The retained value on `settled`; absent otherwise. */
  value?: unknown;
  /** The revision this result was read at — required by `settle` / `release` /
   *  `renew` so they act only on the record the caller actually saw. Present
   *  whenever a record exists. */
  version?: string;
}

/** What a key holds: a claim by one owner, optionally carrying a terminal value.
 *  Stored as ONE record so a claim is a single conditional write — splitting the
 *  owner and the value across keys would reopen a window between writing them. */
interface Envelope {
  holder: string;
  settled: boolean;
  value?: unknown;
}

function asEnvelope(value: unknown): Envelope | null {
  const candidate = value as Envelope | null;
  return candidate && typeof candidate.holder === "string" ? candidate : null;
}

/**
 * The claim protocol — `claim` → (`renew`…) → `settle` | `release` — over any
 * `KvStore`.
 *
 * It lives here, once, rather than in each backend. Both consumers need the same
 * state machine (`Lease.Critical` never settles; `Idempotency.Once` does), and
 * expressing it per-driver meant maintaining the identical ownership guard in
 * three languages — which is three times the surface for a bug that admits a
 * second holder.
 *
 * Every mutating step is guarded by the caller's `version`, so a holder whose
 * claim lapsed cannot touch a record its successor has since written. That guard
 * is what makes TTL-based expiry safe rather than a race.
 */
export class KeyedClaim {
  constructor(private readonly store: KvStore) {}

  /** Take the key if it is free. One conditional write — no read-then-write gap
   *  for a second caller to slip through. */
  async claim(key: string, holder: string, claimTtlMs: number): Promise<ClaimResult> {
    const taken = await this.store.putIfAbsent(key, { holder, settled: false }, claimTtlMs);
    if (taken) return { state: "new", version: taken.version };

    // Lost the race, or the key already holds a terminal record — report which.
    // A record that lapsed between the write and this read reads as `held`: this
    // call did not take the key, so it must not act as though it had.
    const existing = await this.read(key);
    return existing.state === "new" ? { state: "held" } : existing;
  }

  /** Extend a claim this holder owns, by rewriting the same record at a new TTL. */
  async renew(key: string, version: string, claimTtlMs: number): Promise<ClaimResult | null> {
    const current = await this.store.get(key);
    const envelope = current && current.version === version ? asEnvelope(current.value) : null;
    if (!envelope || envelope.settled) return null;
    const next = await this.store.compareAndSet(key, version, envelope, claimTtlMs);
    return next ? { state: "held", holder: envelope.holder, version: next.version } : null;
  }

  /** Turn a claim this holder owns into a terminal record retained for `ttlMs`. */
  async settle(
    key: string,
    version: string,
    holder: string,
    value: unknown,
    ttlMs: number,
  ): Promise<ClaimResult | null> {
    const next = await this.store.compareAndSet(
      key,
      version,
      { holder, settled: true, value },
      ttlMs,
    );
    return next ? { state: "settled", value, version: next.version } : null;
  }

  /** Drop a claim this holder owns, freeing the key immediately for a retry. */
  async release(key: string, version: string): Promise<boolean> {
    return this.store.compareAndDelete(key, version);
  }

  /** Current state without claiming. Advisory: acting on it is a race, so branch
   *  on `claim`'s return instead. */
  async read(key: string): Promise<ClaimResult> {
    const current = await this.store.get(key);
    if (!current) return { state: "new" };
    const envelope = asEnvelope(current.value);
    if (!envelope) return { state: "new" };
    return envelope.settled
      ? { state: "settled", value: envelope.value, version: current.version }
      : { state: "held", holder: envelope.holder, version: current.version };
  }
}

/** A fresh owner token. Opaque; used as the release/settle guard alongside the
 *  record version, and as the value a losing caller is told about. */
export function newHolderToken(): string {
  return randomUUID();
}
