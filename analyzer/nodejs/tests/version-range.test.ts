import { describe, expect, it } from "vitest";

import {
  isUnsatisfiable,
  lowerBound,
  parseVersionRange,
  rangeAccepts,
  upperBound,
} from "../src/version-range.js";

function parsed(raw: string) {
  const result = parseVersionRange(raw);
  if (!result.ok) throw new Error(`expected '${raw}' to parse: ${result.error.message}`);
  return result.range;
}

function refusal(raw: unknown) {
  const result = parseVersionRange(raw);
  if (result.ok) throw new Error(`expected '${String(raw)}' to be refused`);
  return result.error;
}

describe("parseVersionRange", () => {
  it("accepts a single lower bound", () => {
    const range = parsed(">=0.80.0");
    expect(range.comparators).toHaveLength(1);
    expect(range.comparators[0]).toMatchObject({ operator: ">=", raw: "0.80.0" });
  });

  it("accepts a conjunction separated by spaces or commas", () => {
    for (const raw of [">=0.40.0 <0.50.0", ">=0.40.0,<0.50.0", ">=0.40.0, <0.50.0"]) {
      const range = parsed(raw);
      expect(range.comparators.map((c) => c.operator)).toEqual([">=", "<"]);
    }
  });

  // The caret is the spelling semver intuition reaches for, and pre-1.0 it means
  // one minor — which under this repo's minor-bump policy pins a module to a
  // single breaking-change generation. Refusing it is the point of the grammar.
  it("refuses ^ and ~ and names the spelling to use instead", () => {
    for (const raw of ["^0.40.0", "~0.40.0"]) {
      const error = refusal(raw);
      expect(error.hint).toBe(">=0.40.0");
      expect(error.message).toContain("0.41.0");
    }
  });

  it("refuses a bare version, which semver would read as an exact pin", () => {
    expect(refusal("0.80.0").hint).toBe(">=0.80.0");
    expect(refusal("=0.80.0").hint).toBe(">=0.80.0");
  });

  // A disjunction has no single low or high edge, and the edges are what
  // verification runs the CLI at.
  it("refuses disjunctions, hyphen ranges and wildcards", () => {
    expect(refusal(">=0.1.0 || >=0.2.0").message).toContain("disjunction");
    expect(refusal("0.40.0 - 0.50.0").message).toContain("hyphen");
    for (const wild of ["*", "x", "0.x", "1.2.x", "1.2.*", "1.*.0"]) {
      expect(refusal(wild).message, wild).toContain("wildcard");
    }
  });

  // A hint is a repair the author is meant to paste, so one this parser would
  // itself reject turns a diagnostic into a loop. `1.2.*` used to fall through
  // to the no-comparator branch and suggest `>=1.2.*`.
  it("never emits a hint it would reject on the next run", () => {
    for (const bad of ["1.2.*", "0.76", "2024.1", "=0.76"]) {
      const hint = refusal(bad).hint;
      if (hint !== undefined) {
        expect(parseVersionRange(hint).ok, `${bad} -> ${hint}`).toBe(true);
      }
    }
    // The hint is still offered where it is genuinely valid.
    expect(refusal("0.80.0").hint).toBe(">=0.80.0");
  });

  it("refuses non-strings, empty strings and unparseable versions", () => {
    expect(refusal(undefined).message).toContain("expected a version range string");
    expect(refusal(42).message).toContain("number");
    expect(refusal("   ").message).toContain("expected a version range string");
    expect(refusal(">=1.2").message).toContain("three-part version");
  });
});

describe("rangeAccepts", () => {
  it("applies every comparator", () => {
    const range = parsed(">=0.40.0 <0.50.0");
    expect(rangeAccepts(range, "0.40.0")).toBe(true);
    expect(rangeAccepts(range, "0.49.9")).toBe(true);
    expect(rangeAccepts(range, "0.39.9")).toBe(false);
    expect(rangeAccepts(range, "0.50.0")).toBe(false);
  });

  it("compares prereleases by plain precedence", () => {
    const range = parsed(">=0.80.0");
    // Past 0.80.0 in precedence, so genuinely satisfied — unlike npm's rule,
    // which exists to stop a range dragging a consumer onto an -rc build. Here
    // the version tested is the runtime the user is already on.
    expect(rangeAccepts(range, "0.81.0-rc.1")).toBe(true);
    // A prerelease OF the bound is below it.
    expect(rangeAccepts(range, "0.80.0-rc.1")).toBe(false);
  });

  // "Cannot tell" must never read as "yes" — the caller is asking whether a real
  // runtime is admitted.
  it("refuses an unparseable version rather than passing it", () => {
    expect(rangeAccepts(parsed(">=0.1.0"), "latest")).toBe(false);
  });
});

describe("edges", () => {
  it("reports the binding bound when several point the same way", () => {
    const range = parsed(">=0.40.0 >=0.45.0 <0.60.0 <0.50.0");
    expect(lowerBound(range)?.raw).toBe("0.45.0");
    expect(upperBound(range)?.raw).toBe("0.50.0");
  });

  it("leaves an open range without an upper edge", () => {
    expect(upperBound(parsed(">=0.80.0"))).toBeUndefined();
  });
});

describe("isUnsatisfiable", () => {
  it("detects bounds that exclude each other", () => {
    expect(isUnsatisfiable(parsed(">=0.90.0 <0.80.0"))).toBe(true);
    expect(isUnsatisfiable(parsed(">=0.80.0 <0.80.0"))).toBe(true);
    expect(isUnsatisfiable(parsed(">0.80.0 <=0.80.0"))).toBe(true);
  });

  it("accepts a range admitting exactly one version", () => {
    expect(isUnsatisfiable(parsed(">=0.80.0 <=0.80.0"))).toBe(false);
    expect(isUnsatisfiable(parsed(">=0.80.0"))).toBe(false);
  });
});
