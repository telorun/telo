import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { expandManifestFragments, MANIFEST_SCHEMA_URI } from "../src/manifest-schemas.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * `steps.<name>.result` of a pure step whose `value:` is written literally is
 * typed by what is written, by the rule the step engine reads it with: an
 * integral number is an `int`, any other number a `double`, a map a closed
 * record, and a tagged member open.
 */

const cel = (source: string) => makeTaggedSentinel("cel", source);

const SEQUENCE = {
  kind: "Telo.Definition",
  metadata: { name: "Sequence", module: "srv" },
  capability: "Telo.Runnable",
  schema: {
    type: "object",
    properties: {
      steps: { type: "array", items: { $ref: `${MANIFEST_SCHEMA_URI}#/$defs/Step` } },
    },
  },
};
expandManifestFragments(SEQUENCE);

/** The diagnostics a body's expressions raise, as `<code>: <message>`. */
function check(steps: unknown[]): string[] {
  const manifests = [
    { kind: "Telo.Application", metadata: { name: "App", source: "telo.yaml" } },
    SEQUENCE,
    { kind: "srv.Sequence", metadata: { name: "main", source: "telo.yaml" }, steps },
  ] as unknown as ResourceManifest[];
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions(manifests))
    .filter((d) => d.code.startsWith("CEL_"))
    .map((d) => `${d.code}: ${d.message}`);
}

const reading = (value: unknown, source: string) =>
  check([
    { name: "written", value },
    { name: "read", value: cel(source) },
  ]);

describe("a literal `value:` step's result", () => {
  it("is an int when the number is integral", () => {
    expect(reading(3, "steps.written.result * 2")).toEqual([]);
    const [refused, ...rest] = reading(3, "steps.written.result * 2.0");
    expect(refused).toContain('CEL_TYPE_ERROR: srv.Sequence/main: !cel: no "*" is declared over int, double');
    expect(rest).toEqual([]);
  });

  it("is a double when the number is not integral", () => {
    expect(reading(3.5, "steps.written.result * 2.0")).toEqual([]);
    const [refused, ...rest] = reading(3.5, "steps.written.result * 2");
    expect(refused).toContain('no "*" is declared over double, int');
    expect(rest).toEqual([]);
  });

  it("is a double when the integral number is outside int64", () => {
    for (const written of [1e30, 9223372036854775807]) {
      expect(reading(written, "steps.written.result * 2.0")).toEqual([]);
      const [refused, ...rest] = reading(written, "steps.written.result * 2");
      expect(refused).toContain('no "*" is declared over double, int');
      expect(rest).toEqual([]);
    }
  });

  it("is refused where its type has no such operator", () => {
    const [refused, ...rest] = reading(3, "steps.written.result + 'a'");
    expect(refused).toContain('CEL_TYPE_ERROR: srv.Sequence/main: !cel: no "+" is declared over int, string');
    expect(rest).toEqual([]);
  });

  it("is a closed record of a literal map's members, at every depth", () => {
    const value = { count: 3, list: [1, 2] };
    expect(reading(value, "steps.written.result.count * 2 + steps.written.result.list[0]")).toEqual([]);
    const [unknown, ...rest] = reading(value, "steps.written.result.cuont");
    expect(unknown).toBe(
      'CEL_UNKNOWN_FIELD: srv.Sequence/main: !cel: "cuont" is not declared here (declared: count, list)',
    );
    expect(rest).toEqual([]);
  });

  it("joins with a map literal, or a differently shaped literal map, across a condition", () => {
    const steps = (source: string) => [
      { name: "written", value: { exchanged: false, missing: true } },
      { name: "other", value: { refused: true } },
      { name: "read", value: cel(source) },
    ];
    expect(check(steps("has(steps.written) ? steps.written.result : {'exchanged': true}"))).toEqual([]);
    expect(check(steps("has(steps.written) ? steps.written.result : steps.other.result"))).toEqual([]);
    const [refused, ...rest] = check(steps("has(steps.written) ? steps.written.result : 3"));
    expect(refused).toContain("CEL_TYPE_ERROR");
    expect(rest).toEqual([]);
  });

  it("leaves a tagged member of a literal map untyped", () => {
    const value = { computed: cel("1.0 + 1.0") };
    expect(reading(value, "steps.written.result.computed * 2")).toEqual([]);
    expect(reading(value, "steps.written.result.computed * 2.0")).toEqual([]);
  });

  it("types a list by its elements only when they all agree", () => {
    expect(reading([1, 2.5], "steps.written.result[0] * 2")).toEqual([]);
    expect(reading([1, 2.5], "steps.written.result[1] * 2.0")).toEqual([]);
    const [refused] = reading([1, 2], "steps.written.result[0] * 2.0");
    expect(refused).toContain('no "*" is declared over int, double');
  });

  it("claims nothing where another step of the same name holds a different value", () => {
    const steps = [
      {
        name: "branch",
        if: cel("true"),
        then: [{ name: "picked", value: "none" }],
        else: [{ name: "picked", value: 3 }],
      },
      { name: "read", value: cel("steps.picked.result == 3 || steps.picked.result == 'none'") },
    ];
    expect(check(steps)).toEqual([]);
  });

  it("keeps a whole-value expression typed by what it checks to", () => {
    const [refused, ...rest] = reading(cel("1.0 + 1.0"), "steps.written.result * 2");
    expect(refused).toContain('no "*" is declared over double, int');
    expect(rest).toEqual([]);
  });
});

describe("a step name several steps carry", () => {
  const loop = (advance: string) => {
    const seed = { name: "i", value: 0 };
    const spin = {
      name: "spin",
      while: cel("steps.i.result < 3"),
      do: [{ name: "i", value: cel(advance) }],
    };
    return [
      [seed, spin],
      [spin, seed],
    ];
  };

  it("is read by an expression step as what the other steps of its name produce", () => {
    for (const steps of loop("steps.i.result + 1.0")) {
      const [refused, ...rest] = check(steps);
      expect(refused).toContain('CEL_TYPE_ERROR: srv.Sequence/main: !cel: no "+" is declared over int, double');
      expect(rest).toEqual([]);
    }
  });

  it("is typed where every step of the name agrees", () => {
    for (const steps of loop("steps.i.result + 1")) {
      expect(check(steps)).toEqual([]);
      const [refused, ...rest] = check([...steps, { name: "read", value: cel("steps.i.result * 2.0") }]);
      expect(refused).toContain('no "*" is declared over int, double');
      expect(rest).toEqual([]);
    }
  });

  it("claims nothing where a literal and an expression disagree, in either order", () => {
    const written = { name: "picked", value: 3 };
    const computed = { name: "picked", value: cel("2.5") };
    for (const [then, otherwise] of [
      [written, computed],
      [computed, written],
    ]) {
      const steps = [
        { name: "branch", if: cel("true"), then: [then], else: [otherwise] },
        { name: "read", value: cel("steps.picked.result * 2.0") },
      ];
      expect(check(steps)).toEqual([]);
    }
  });

  it("claims nothing where two expressions disagree", () => {
    const steps = [
      {
        name: "branch",
        if: cel("true"),
        then: [{ name: "picked", value: cel("1") }],
        else: [{ name: "picked", value: cel("2.5") }],
      },
      { name: "read", value: cel("steps.picked.result * 2") },
    ];
    expect(check(steps)).toEqual([]);
  });
});

describe("a misspelled step name", () => {
  it("is reported once, beside a literal step and beside an expression step", () => {
    for (const value of [3, cel("3")]) {
      expect(reading(value, "steps.writen.result")).toEqual([
        'CEL_UNKNOWN_FIELD: srv.Sequence/main: !cel: "writen" is not declared here (declared: written, read)',
      ]);
    }
  });
});
