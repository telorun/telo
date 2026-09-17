import { describe, expect, it } from "vitest";
import { Duration } from "../src/cel-value-identity.js";
import { PLAIN_ENCODINGS } from "../src/plain-encoding.js";
import { UnsignedInt } from "../src/cel-value-identity.js";
import {
  CEL_SCALAR_FORMS,
  markExactRendering,
  parseValueTypeEntry,
  VALUE_TYPES,
} from "../src/value-type.js";

describe("value-type vocabulary", () => {
  it("reads every entry, with an encoding on each non-live instance and none elsewhere", () => {
    const encodings = Object.fromEntries(
      [...VALUE_TYPES.values()].map((entry) => [entry.name, entry.encoding]),
    );
    expect(encodings).toEqual({
      "Telo.Bytes": "base64url",
      "Telo.Duration": "cel-duration",
      "Telo.Stream": undefined,
      "Telo.TcpPort": undefined,
      "Telo.Timestamp": "rfc3339",
      "Telo.UdpPort": undefined,
      "Telo.Uint64": undefined,
    });
    expect(VALUE_TYPES.get("Telo.Uint64")?.celType).toBe("uint");
  });

  it("accepts an unsigned integer at the top of its range, in every representation", () => {
    const accepts = CEL_SCALAR_FORMS.uint!.range!.accepts;
    const max = 2n ** 64n - 1n;
    expect(accepts(new UnsignedInt(max))).toBe(true);
    expect(accepts(max)).toBe(true);
    // A number is exact only up to 2^53 - 1; the literal of the top of the range
    // already reads as 2^64, so written as a number it is refused…
    expect(accepts(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(accepts(Number(max))).toBe(false);
    // …unless a validator's view rendered it, as a double, from the exact value.
    const view = { quota: Number(max) };
    markExactRendering(view, "quota");
    expect(accepts(view.quota, view, "quota")).toBe(true);
    expect(accepts(0)).toBe(true);
    expect(accepts(-1)).toBe(false);
    expect(accepts(2n ** 64n)).toBe(false);
    expect(accepts(1.5)).toBe(false);
  });

  it("refuses a `celType` its base cannot carry, and one on an instance", () => {
    expect(() =>
      parseValueTypeEntry("wrong-base.json", {
        name: "Telo.Wrong",
        representation: "json",
        base: "number",
        celType: "uint",
        description: "x",
      }),
    ).toThrow(/is not a CEL type a 'number' base carries beyond its own/);
    expect(() =>
      parseValueTypeEntry("instance-cel.json", {
        name: "Telo.WrongInstance",
        representation: "instance",
        binding: "bytes",
        encoding: "base64url",
        celType: "uint",
        description: "x",
      }),
    ).toThrow(/takes no 'base' or 'celType'/);
  });
});

describe("plain encodings", () => {
  const { base64url, rfc3339 } = PLAIN_ENCODINGS;
  const celDuration = PLAIN_ENCODINGS["cel-duration"]!;

  it("write the canonical form and read it back", () => {
    const bytes = new Uint8Array([251, 255, 0]);
    expect(base64url!.encode(bytes)).toBe("-_8A");
    expect(base64url!.decode("-_8A")).toEqual(bytes);

    const instant = rfc3339!.decode("2026-01-15T09:30:00.25+02:00") as Date;
    expect(rfc3339!.encode(instant)).toBe("2026-01-15T07:30:00.250Z");
    // A year below 100 is that year, as CEL's `timestamp()` reads it.
    expect(rfc3339!.decode("0050-01-01T00:00:00Z")).toEqual(new Date("0050-01-01T00:00:00Z"));

    expect(celDuration.encode(celDuration.decode("1h30m"))).toBe("5400s");
    expect(celDuration.encode(new Duration(-1, -500_000_000))).toBe("-1.5s");
  });

  it("read nothing outside the encoding", () => {
    expect(base64url!.decode("-_8A=")).toBeUndefined();
    expect(rfc3339!.decode("2026-02-30T00:00:00Z")).toBeUndefined();
    expect(rfc3339!.decode("2026-01-15T09:30:00+24:00")).toBeUndefined();
    expect(rfc3339!.decode("2026-01-15 09:30")).toBeUndefined();
    expect(celDuration.decode("90 minutes")).toBeUndefined();
    expect(celDuration.encode(celDuration.decode("-315576000000.999999999s"))).toBe("-315576000000.999999999s");
    expect(celDuration.decode("315576000001s")).toBeUndefined();
    expect(celDuration.decode(`1${"0".repeat(40)}h`)).toBeUndefined();
  });
});
