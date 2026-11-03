import { celDurationFromNanos, celTimestamp, isCelDuration, isCelTimestamp } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import {
  postgresCurrentInstantPlus,
  postgresInstantParameter,
} from "../src/schema/postgres-instants.js";

const DESCRIBE = 'Postgres.Schema "test"';

function duration(nanos: bigint) {
  const built = celDurationFromNanos(nanos);
  if (!isCelDuration(built)) throw new Error("duration out of range");
  return built;
}

// What the server does with these is not run here — that needs a server. This
// pins what is bound: an interval in whole hours plus seconds, both carrying the
// duration's sign, and a UTC instant, each truncated to the microsecond.
describe("Postgres instants", () => {
  it("binds the shift as an interval of hours and seconds, truncated toward zero", () => {
    const later = postgresCurrentInstantPlus(duration(3_725_000_001_999n), DESCRIBE);
    expect(later.fragments).toEqual(["(clock_timestamp() + CAST(", " AS interval))"]);
    expect(later.boundValues).toEqual(["+1 hours +125.000001 seconds"]);
    expect(postgresCurrentInstantPlus(duration(-1_500n), DESCRIBE).boundValues).toEqual([
      "-0 hours -0.000001 seconds",
    ]);
  });

  it("binds an instant as UTC text, truncated toward the past", () => {
    const instant = celTimestamp(-1n, 999_999_999);
    if (!isCelTimestamp(instant)) throw new Error("timestamp out of range");
    const bound = postgresInstantParameter(instant, DESCRIBE);
    expect(bound.fragments).toEqual(["CAST(", " AS timestamptz)"]);
    expect(bound.boundValues).toEqual(["1969-12-31T23:59:59.999999Z"]);
  });
});
