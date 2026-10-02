/**
 * The member-read seam, a test per clause of its contract.
 *
 * Each of these is a way a host property read would leak through if the seam were not the
 * single lookup: a key that names a prototype member, a key computed from a request, a
 * select on something that is not a map, an index past the end of a list.
 */
import { describe, expect, it } from "vitest";
import { CelEnvironment, CelEvaluationError, type CelValue } from "../src/index.js";

const environment = new CelEnvironment({ unlistedVariablesAreDyn: true, enableOptionalTypes: true });

function evaluate(source: string, activation: Record<string, unknown> = {}): CelValue {
  return environment.evaluate(source, activation);
}

function failure(source: string, activation: Record<string, unknown> = {}): string {
  try {
    evaluate(source, activation);
  } catch (cause) {
    if (cause instanceof CelEvaluationError) return cause.code;
    throw cause;
  }
  throw new Error(`${source} answered instead of failing`);
}

describe("the member-read seam", () => {
  it("round-trips every key as data, the three host names included", () => {
    expect(evaluate("{'__proto__': 1, 'constructor': 2, 'prototype': 3}.__proto__")).toBe(1n);
    expect(evaluate("{'__proto__': 1, 'constructor': 2, 'prototype': 3}['constructor']")).toBe(2n);
    expect(evaluate("size({'__proto__': 1, 'constructor': 2, 'prototype': 3})")).toBe(3n);
    expect(evaluate("'prototype' in {'prototype': 3}")).toBe(true);
  });

  it("finds nothing for a computed key naming a host member", () => {
    const activation = { held: { a: 1n }, key: "constructor" };
    expect(failure("held[key]", activation)).toBe("no_such_key");
    expect(evaluate("has(held.constructor)", activation)).toBe(false);
    expect(evaluate("held[?key].hasValue()", activation)).toBe(false);
  });

  it("answers a missing key as an error value that short-circuits", () => {
    expect(failure("{'a': 1}.b")).toBe("no_such_key");
    expect(evaluate("false && {'a': 1}.b == 1")).toBe(false);
    expect(evaluate("true || {'a': 1}.b == 1")).toBe(true);
  });

  it("refuses a select on a value that holds no members, rather than finding one", () => {
    expect(failure("dyn('abc').length")).toBe("unsupported_container");
    expect(failure("dyn(1).toString")).toBe("unsupported_container");
    // A list holds elements, so a name is not a key of it — an error either way, and
    // never the host's `length`.
    expect(failure("dyn([1, 2]).length")).toBe("unsupported_key_type");
  });

  it("bounds-checks an index into a list", () => {
    expect(evaluate("[1, 2, 3][2]")).toBe(3n);
    expect(failure("[1, 2, 3][3]")).toBe("index_out_of_range");
    expect(failure("[1, 2, 3][-1]")).toBe("index_out_of_range");
    expect(evaluate("[1, 2, 3][?5].hasValue()")).toBe(false);
  });

  it("reads an own entry of a host's object, never an inherited one", () => {
    const held = { own: 2n };
    expect(evaluate("held.own", { held })).toBe(2n);
    expect(failure("held.toString", { held })).toBe("no_such_key");
    expect(failure("held.hasOwnProperty", { held })).toBe("no_such_key");
  });

  it("treats a host value that is not a plain object as no container at all", () => {
    const instance = Object.create({ secret: 1n }) as Record<string, unknown>;
    instance.own = 2n;
    expect(failure("held.own", { held: instance })).toBe("unsupported_container");
    expect(failure("held.own", { held: () => 1 })).toBe("unsupported_container");
  });
});
