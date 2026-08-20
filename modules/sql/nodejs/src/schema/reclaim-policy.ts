import { parseDurationMs } from "@telorun/sdk";
import type { TombstoneRecord, VersionRecord } from "./schema-ledger.js";

/**
 * When a tombstone may be reclaimed. Eligibility is a CONJUNCTION: N released
 * versions must have been observed since the object went missing, AND T must
 * have elapsed. Version is the primary signal — it is what proves older code is
 * no longer live — and time is the backstop, because N versions can land in an
 * afternoon.
 *
 * Declaring no policy means nothing is ever dropped, so reclamation is opt-in
 * by declaration rather than by invocation.
 */
export interface ReclaimPolicy {
  readonly afterVersions: number;
  readonly afterDuration: string;
}

export interface Eligibility {
  readonly eligible: boolean;
  /** Versions observed since the tombstone, and how many are still needed. */
  readonly versionsObserved: number;
  readonly versionsRemaining: number;
  readonly msElapsed: number;
  readonly msRemaining: number;
}

/**
 * A rollback resets progress rather than merely pausing it.
 *
 * Going backwards proves older code is live, so a boot at a version that was
 * already observed at or before the tombstone is not one more release past the
 * removal — it is evidence the removal is not yet safe. Both counters restart
 * from that observation: the version count, and the elapsed-time baseline. This
 * is answerable only because the ledger records the observed *sequence* rather
 * than a counter.
 */
export function assessTombstone(
  tombstone: TombstoneRecord,
  history: readonly VersionRecord[],
  policy: ReclaimPolicy,
  nowMs: number,
): Eligibility {
  const priorVersions = new Set(
    history
      .filter((entry) => entry.sequence <= tombstone.missingSinceSequence)
      .map((entry) => entry.version),
  );
  let counted = new Set<string>();
  let baselineAt = tombstone.missingSinceAt;
  for (const entry of history) {
    if (entry.sequence <= tombstone.missingSinceSequence) continue;
    if (priorVersions.has(entry.version)) {
      counted = new Set();
      baselineAt = entry.firstSeenAt;
      continue;
    }
    counted.add(entry.version);
  }

  const versionsObserved = counted.size;
  const msElapsed = Math.max(0, nowMs - Date.parse(baselineAt));
  const requiredMs = parseDurationMs(policy.afterDuration);
  const versionsRemaining = Math.max(0, policy.afterVersions - versionsObserved);
  const msRemaining = Math.max(0, requiredMs - msElapsed);
  return {
    eligible: versionsRemaining === 0 && msRemaining === 0,
    versionsObserved,
    versionsRemaining,
    msElapsed,
    msRemaining,
  };
}
