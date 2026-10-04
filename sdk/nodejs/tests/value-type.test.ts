import { describe, expect, it } from "vitest";
import { celDurationFromNanos, celTimestamp, celUint } from "../src/cel-value-identity.js";
import { PLAIN_ENCODINGS } from "../src/plain-encoding.js";
import {
  CEL_SCALAR_FORMS,
  hostAnchorOf,
  isAbsoluteHostPath,
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
    expect(accepts(celUint(max))).toBe(true);
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

  it("reads a host path: a brand over string anchored at the working directory", () => {
    const entry = VALUE_TYPES.get("Telo.HostPath")!;
    expect(entry).toMatchObject({ base: "string", fromHost: "working-directory" });
    expect(entry.celType).toBeUndefined();
    expect(hostAnchorOf({ "x-telo-type": "Telo.HostPath" })).toBe("working-directory");
    expect(hostAnchorOf({ "x-telo-type": "Telo.TcpPort" })).toBeUndefined();
  });

  it("refuses an anchor on anything but a string, and one no runtime knows", () => {
    const hostPath = (fields: Record<string, unknown>) => () =>
      parseValueTypeEntry("anchor.json", {
        name: "Telo.Anchored",
        representation: "json",
        base: "string",
        description: "x",
        ...fields,
      });
    expect(hostPath({ base: "integer", fromHost: "working-directory" })).toThrow(/needs a 'string' base/);
    expect(hostPath({ fromHost: "home-directory" })).toThrow(/is not an anchor this runtime knows/);
  });
});

describe("isAbsoluteHostPath", () => {
  it("judges POSIX, drive-letter and UNC paths absolute on every host", () => {
    for (const path of ["/srv/www", "C:\\data", "c:/data", "\\\\server\\share"]) {
      expect(isAbsoluteHostPath(path)).toBe(true);
    }
    for (const path of ["./public", "public", "../up", "C:relative", ""]) {
      expect(isAbsoluteHostPath(path)).toBe(false);
    }
  });
});

describe("plain encodings", () => {
  const { base64url, rfc3339 } = PLAIN_ENCODINGS;
  const celDuration = PLAIN_ENCODINGS["cel-duration"]!;

  it("write the canonical form and read it back", () => {
    const bytes = new Uint8Array([251, 255, 0]);
    expect(base64url!.encode(bytes)).toBe("-_8A");
    expect(base64url!.decode("-_8A")).toEqual(bytes);

    // The fraction is written to the precision it carries, with no trailing zero, and
    // is absent when the instant is whole — CEL's own `string(timestamp)`.
    expect(rfc3339!.encode(rfc3339!.decode("2026-01-15T09:30:00.25+02:00"))).toBe(
      "2026-01-15T07:30:00.25Z",
    );
    expect(rfc3339!.encode(rfc3339!.decode("2026-01-15T07:30:00.000Z"))).toBe(
      "2026-01-15T07:30:00Z",
    );
    // A nanosecond instant is representable, which no host date type makes it.
    expect(rfc3339!.decode("2026-01-15T07:30:00.000000001Z")).toEqual(
      celTimestamp(1768462200n, 1),
    );
    expect(rfc3339!.encode(celTimestamp(1768462200n, 1))).toBe("2026-01-15T07:30:00.000000001Z");
    // A year below 100 is that year, as CEL's `timestamp()` reads it.
    expect(rfc3339!.decode("0050-01-01T00:00:00Z")).toEqual(celTimestamp(-60589296000n, 0));

    expect(celDuration.encode(celDuration.decode("1h30m"))).toBe("5400s");
    expect(celDuration.encode(celDurationFromNanos(-1_500_000_000n))).toBe("-1.5s");
  });

  it("read nothing outside the encoding", () => {
    expect(base64url!.decode("-_8A=")).toBeUndefined();
    expect(rfc3339!.decode("2026-02-30T00:00:00Z")).toBeUndefined();
    expect(rfc3339!.decode("2026-01-15T09:30:00+24:00")).toBeUndefined();
    expect(rfc3339!.decode("2026-01-15 09:30")).toBeUndefined();
    // A tenth fractional digit is refused rather than rounded: rounding would read a
    // precision this domain does not hold as one it does.
    expect(rfc3339!.decode("2026-01-15T07:30:00.0000000001Z")).toBeUndefined();
    expect(rfc3339!.decode("10000-01-01T00:00:00Z")).toBeUndefined();
    expect(celDuration.decode("90 minutes")).toBeUndefined();
    // **This encoding's range is protobuf's, which is WIDER than CEL's own.** A duration
    // here reaches ±10,000 years, because a journal entry, a transport's payload and a
    // controller's value all do; CEL's duration is one int64 of nanoseconds (~±292
    // years) and a value past it is refused where it enters the engine rather than
    // where it is read. Both bounds are pinned, so the one that moves is the one that
    // fails: protobuf's edge decodes, and so does a duration past CEL's own.
    expect(celDuration.encode(celDuration.decode("-315576000000.999999999s"))).toBe(
      "-315576000000.999999999s",
    );
    expect(celDuration.encode(celDuration.decode("20000000000s"))).toBe("20000000000s");
    expect(celDuration.decode("315576000001s")).toBeUndefined();
    expect(celDuration.decode(`1${"0".repeat(40)}h`)).toBeUndefined();
  });
});
