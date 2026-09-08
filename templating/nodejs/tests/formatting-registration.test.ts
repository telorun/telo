import { describe, expect, it } from "vitest";
import { buildCelEnvironment } from "../src/cel/environment.js";

/** The formatting surface's SEMANTICS are asserted in `tests/cel-formatting.yaml`,
 *  as a manifest — that is the artifact every Telo runtime can already execute,
 *  so a second CEL engine conforms by running it rather than by reimplementing a
 *  harness, and an int64 or an instant is written in CEL rather than encoded.
 *
 *  What stays here is what a manifest cannot state: claims about REGISTRATION and
 *  static typing. A function that computes correctly but is registered under the
 *  wrong signature is unreachable from a manifest, so the manifest would simply
 *  fail to check rather than say why. */
describe("formatting registration", () => {
  const env = buildCelEnvironment();

  it("resolves a timestamp argument, which needs the protobuf type name", () => {
    // The documented `timestamp` spelling does not resolve on its own — the
    // registration has to name `google.protobuf.Timestamp`, as the existing
    // `string(timestamp)` / `int(timestamp)` entries do.
    expect(env.check("dateIn(timestamp('2026-03-01T00:30:00Z'), 'America/New_York')").valid).toBe(
      true,
    );
    expect(env.check("isoIn(timestamp(0))").valid).toBe(true);
  });

  it("types a calendar shift as a timestamp, so it composes with timestamp arithmetic", () => {
    expect(env.check("startOfMonth(timestamp(0))").type).toBe("google.protobuf.Timestamp");
    expect(env.check("addMonths(timestamp(0), 1)").type).toBe("google.protobuf.Timestamp");
    expect(env.check("string(startOfMonth(timestamp(0)))").type).toBe("string");
  });

  it("registers both arities of round", () => {
    expect(env.check("round(1.5)").valid).toBe(true);
    expect(env.check("round(1.5, 2)").valid).toBe(true);
  });

  it("registers each zone-taking function at both arities", () => {
    for (const call of ["dateIn", "isoIn", "startOfMonth"]) {
      expect(env.check(`${call}(timestamp(0))`).valid, `${call} minimal arity`).toBe(true);
      expect(env.check(`${call}(timestamp(0), 'UTC')`).valid, `${call} with zone`).toBe(true);
    }
    expect(env.check("addMonths(timestamp(0), 1, 'UTC')").valid).toBe(true);
  });

  it("types every formatter as a string, so it composes with concatenation", () => {
    expect(env.check("'x' + format(1.0, '.2f')").valid).toBe(true);
    expect(env.check("'x' + fixed(1.0, 2)").valid).toBe(true);
    expect(env.check("'x' + formatDuration(510, 480)").valid).toBe(true);
  });
});
