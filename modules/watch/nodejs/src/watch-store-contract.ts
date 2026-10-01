import { UnsignedInt, type CancellationToken } from "@telorun/sdk";

/** What a wait ends with: whether the topic moved past the cursor, and the
 *  version the store knows for it at that moment. */
export interface WatchSignal {
  changed: boolean;
  version: bigint;
}

/**
 * The `Watch.Store` contract (normative: `docs/store-contract.md`). A backend
 * remembers the latest version per topic and holds waiters until it passes
 * their cursor; it is a wake-up signal only, never the source of truth.
 */
export interface WatchStore {
  /** Raise the topic's remembered version to `version` when that is higher —
   *  a lower or equal one changes nothing — waking every waiter whose cursor is
   *  now below it. Resolves with no value once applied. */
  raise(topic: string, version: bigint): Promise<void>;
  /** Resolve `{ changed: true }` once the remembered version exceeds `after`
   *  (at once when it already does), `{ changed: false }` after `timeoutMs`, or
   *  `{ changed: false }` once `cancellation` is cancelled — whichever comes
   *  first. Never rejects on the timeout or the cancellation, and releases the
   *  waiter on every path. */
  wait(
    topic: string,
    after: bigint,
    timeoutMs: number,
    cancellation: CancellationToken,
  ): Promise<WatchSignal>;
}

/** Duck-typed, not `instanceof`: a store may be implemented in another module,
 *  whose bundle is its own. */
export function isWatchStore(value: unknown): value is WatchStore {
  const store = value as Partial<WatchStore> | undefined;
  return typeof store?.raise === "function" && typeof store.wait === "function";
}

/** A version read from a call's inputs: a YAML literal arrives as a number, a
 *  CEL value as a BigInt (or an `UnsignedInt`). */
export function versionInput(value: unknown, describe: () => string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (value instanceof UnsignedInt) return value.value;
  throw new Error(`${describe()} must be an integer, got ${JSON.stringify(String(value))}`);
}
