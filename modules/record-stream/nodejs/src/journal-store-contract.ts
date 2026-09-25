/**
 * `RecordStream.JournalStore` — the storage a journal runs over. Normative text:
 * `modules/record-stream/docs/store-contract.md`.
 *
 * Eight journal-agnostic primitives over, per key, a header and an ordered log.
 * The header's value and every record are opaque strings (the journal writes SDK
 * typed frames); a store never interprets them, and names no journal state.
 * Every conditional write takes the version its caller last read, and losing
 * that race returns `null` — an outcome, not an error. A store that cannot
 * complete an operation throws.
 */

import type { CancellationToken } from "@telorun/sdk";

/** A key's header as one snapshot saw it. */
export interface JournalHeader {
  /** Protocol-owned and opaque to the store. */
  value: string;
  /** Opaque and store-generated; advances on every write to the key. */
  version: string;
  /** Milliseconds since the header was last written, on the store's clock. */
  ageMs: number;
}

/** One record of a key's log: its 1-based, gap-free id and its opaque body. */
export interface JournalStoreEntry {
  id: number;
  record: string;
}

/** One snapshot of a key: its header (null when the key is absent) and the
 *  entries after the requested id, at most `limit` of them. */
export interface JournalPage {
  header: JournalHeader | null;
  entries: JournalStoreEntry[];
}

export interface ScannedHeader extends JournalHeader {
  key: string;
}

export interface JournalScan {
  headers: ScannedHeader[];
  /** Opaque; pass it back to continue. Null when the scan is complete. */
  cursor: string | null;
}

export interface JournalStore {
  /** The header and the entries with id greater than `fromId`, at most `limit`,
   *  as one atomic snapshot. */
  read(key: string, fromId: number, limit: number): Promise<JournalPage>;

  /** Create the key with this header and an empty log. Returns the new version,
   *  or null when the key exists. */
  putIfAbsent(key: string, value: string): Promise<string | null>;

  /** Replace the header if the key is still at `version`, stamping the store
   *  clock. Returns the new version, or null. */
  compareAndSet(key: string, version: string, value: string): Promise<string | null>;

  /** Append a record if the key is still at `version`: the id is the next one,
   *  and assigning it, storing the entry and advancing the version are one step.
   *  Does not touch the header's age. Returns the id and the new version, or null. */
  compareAndAppend(
    key: string,
    version: string,
    record: string,
  ): Promise<{ id: number; version: string } | null>;

  /** Drop every entry and write the header, in one step, if the key is still at
   *  `version`. Returns the new version, or null. */
  compareAndTruncate(key: string, version: string, value: string): Promise<string | null>;

  /** Drop the header and every entry if the key is still at `version`. */
  compareAndDelete(key: string, version: string): Promise<boolean>;

  /** Headers at least `minAgeMs` old, oldest first, at most `limit` per call. */
  scan(minAgeMs: number, cursor: string | null, limit: number): Promise<JournalScan>;

  /** Resolve once the key's version differs from `version` (null = absent),
   *  after `timeoutMs`, or once `cancellation` is cancelled — whichever comes
   *  first. Never rejects on the timeout or the cancellation. Once cancelled it
   *  releases its timer and its waiter entry and issues no further statement
   *  (one already in flight finishes and its result is discarded). */
  wait(key: string, version: string | null, timeoutMs: number, cancellation: CancellationToken): Promise<void>;
}

/**
 * True when a value exposes the store contract. Duck-typed, not `instanceof`: a
 * store is implemented in another module, whose bundle is its own.
 */
export function isJournalStore(value: unknown): value is JournalStore {
  const s = value as Partial<JournalStore> | undefined;
  return (
    typeof s?.read === "function" &&
    typeof s.putIfAbsent === "function" &&
    typeof s.compareAndSet === "function" &&
    typeof s.compareAndAppend === "function" &&
    typeof s.compareAndTruncate === "function" &&
    typeof s.compareAndDelete === "function" &&
    typeof s.scan === "function" &&
    typeof s.wait === "function"
  );
}
