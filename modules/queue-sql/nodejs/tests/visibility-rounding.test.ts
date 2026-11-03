import {
  celDurationFromNanos,
  celTimestamp,
  durationNanos,
  timestampNanos,
  type CelDuration,
  type CelTimestamp,
} from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { ceilDurationToMillis, ceilTimestampToMillis } from "../src/sql-queue-store.js";

describe("visibility rounding", () => {
  it("rounds a delay and an instant up to the millisecond, so a message is never visible early", () => {
    const delay = (nanos: bigint) => durationNanos(ceilDurationToMillis(celDurationFromNanos(nanos) as CelDuration));
    expect([delay(1n), delay(1_000_000n), delay(1_000_001n), delay(0n)]).toEqual([
      1_000_000n,
      1_000_000n,
      2_000_000n,
      0n,
    ]);
    const instant = (nanos: bigint) =>
      timestampNanos(ceilTimestampToMillis(celTimestamp(0n, nanos) as CelTimestamp));
    expect([instant(5_000_000_001n), instant(5_000_000_000n), instant(-1n)]).toEqual([
      5_001_000_000n,
      5_000_000_000n,
      0n,
    ]);
  });
});
