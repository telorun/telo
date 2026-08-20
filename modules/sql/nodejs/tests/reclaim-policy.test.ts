import { describe, expect, it } from "vitest";
import { assessTombstone } from "../src/schema/reclaim-policy.js";
import type { TombstoneRecord, VersionRecord } from "../src/schema/schema-ledger.js";

/**
 * Eligibility gates an irreversible drop, so every arm of the conjunction — and
 * the rollback rule that resets both — is pinned here rather than inferred from
 * an end-to-end run.
 */
const DAY = 86_400_000;
const at = (ms: number) => new Date(ms).toISOString();

function version(sequence: number, name: string, ms: number): VersionRecord {
  return { sequence, version: name, digest: "d", firstSeenAt: at(ms), declaration: {} };
}

function tombstone(sequence: number, ms: number): TombstoneRecord {
  return {
    objectKey: "column:users.nickname",
    kind: "column",
    tableName: "users",
    name: "nickname",
    definition: "{}",
    missingSinceVersion: "2.0.0",
    missingSinceSequence: sequence,
    missingSinceAt: at(ms),
  };
}

const POLICY = { afterVersions: 2, afterDuration: "30d" };

describe("assessTombstone", () => {
  it("holds while neither condition is met", () => {
    const verdict = assessTombstone(tombstone(1, 0), [version(1, "1.0.0", 0)], POLICY, DAY);
    expect(verdict).toMatchObject({ eligible: false, versionsRemaining: 2 });
    expect(verdict.msRemaining).toBe(30 * DAY - DAY);
  });

  it("holds when the versions have landed but the time has not — the backstop", () => {
    const history = [version(1, "2.0.0", 0), version(2, "3.0.0", DAY), version(3, "4.0.0", DAY)];
    const verdict = assessTombstone(tombstone(1, 0), history, POLICY, 2 * DAY);
    expect(verdict).toMatchObject({ eligible: false, versionsRemaining: 0 });
    expect(verdict.msRemaining).toBeGreaterThan(0);
  });

  it("holds when the time has passed but the versions have not", () => {
    const verdict = assessTombstone(tombstone(1, 0), [version(1, "2.0.0", 0)], POLICY, 60 * DAY);
    expect(verdict).toMatchObject({ eligible: false, versionsRemaining: 2, msRemaining: 0 });
  });

  it("is eligible once both hold", () => {
    const history = [version(1, "2.0.0", 0), version(2, "3.0.0", DAY), version(3, "4.0.0", 2 * DAY)];
    expect(assessTombstone(tombstone(1, 0), history, POLICY, 60 * DAY).eligible).toBe(true);
  });

  it("counts a version once however often it is redeployed", () => {
    const history = [
      version(1, "2.0.0", 0),
      version(2, "3.0.0", DAY),
      version(3, "3.0.0", 2 * DAY),
      version(4, "3.0.0", 3 * DAY),
    ];
    const verdict = assessTombstone(tombstone(1, 0), history, POLICY, 60 * DAY);
    expect(verdict.versionsObserved).toBe(1);
    expect(verdict.eligible).toBe(false);
  });

  it("RESETS both counters on a rollback to a version seen before the removal", () => {
    // 1.0.0 was live before the removal; seeing it again proves old code is back.
    const history = [
      version(1, "1.0.0", 0),
      version(2, "2.0.0", DAY),
      version(3, "3.0.0", 2 * DAY),
      version(4, "4.0.0", 3 * DAY),
      version(5, "1.0.0", 4 * DAY),
    ];
    const verdict = assessTombstone(tombstone(2, DAY), history, POLICY, 5 * DAY);
    expect(verdict.versionsObserved).toBe(0);
    expect(verdict.eligible).toBe(false);
    // The clock restarts at the rollback, not at the removal.
    expect(verdict.msElapsed).toBe(DAY);
  });

  it("resumes counting after a rollback rather than being poisoned by it", () => {
    const history = [
      version(1, "1.0.0", 0),
      version(2, "2.0.0", DAY),
      version(3, "1.0.0", 2 * DAY),
      version(4, "3.0.0", 3 * DAY),
      version(5, "4.0.0", 4 * DAY),
    ];
    const verdict = assessTombstone(tombstone(2, DAY), history, POLICY, 90 * DAY);
    expect(verdict.versionsObserved).toBe(2);
    expect(verdict.eligible).toBe(true);
  });

  it("ignores versions observed at or before the removal", () => {
    const history = [version(1, "1.0.0", 0), version(2, "2.0.0", DAY)];
    expect(assessTombstone(tombstone(2, DAY), history, POLICY, 90 * DAY).versionsObserved).toBe(0);
  });

  it("never reports a negative remainder", () => {
    const history = [version(1, "2.0.0", 0), version(2, "3.0.0", DAY), version(3, "4.0.0", 2 * DAY)];
    const verdict = assessTombstone(tombstone(1, 0), history, POLICY, 900 * DAY);
    expect(verdict.versionsRemaining).toBe(0);
    expect(verdict.msRemaining).toBe(0);
  });

  it("treats a clock that went backwards as no time elapsed, never as overdue", () => {
    const verdict = assessTombstone(tombstone(1, 10 * DAY), [version(1, "2.0.0", 0)], POLICY, 0);
    expect(verdict.msElapsed).toBe(0);
    expect(verdict.eligible).toBe(false);
  });
});
