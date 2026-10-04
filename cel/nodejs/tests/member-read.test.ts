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

  it("reads a host's plain object and refuses a host object carrying a prototype of its own", () => {
    // What a host hands a map over as, and the boundary of it. A plain object (or a
    // prototype-free one) is a map; an object whose prototype is its OWN is not, however
    // data-like it looks — the seam resolves a key against a value's own entries and never
    // performs a host property read, so it cannot tell a bag from an instance with methods.
    //
    // This is the shape the failure came in: a transport's query bag, built as
    // `new Empty()` over `Object.create(null)`, read as holding no members at all — so
    // every handler reading the query string answered 500. A host hands such a bag over as
    // a plain object instead; the engine does not widen to meet it, because a reading that
    // accepted any data-like object would make a class instance's `length` and `call`
    // reachable from a computed key.
    const Empty = function (this: Record<string, unknown>) {} as unknown as new () => Record<
      string,
      unknown
    >;
    Empty.prototype = Object.create(null) as object;
    const bag = new Empty();
    bag.page = "2";

    expect(evaluate("q.page", { q: { page: "2" } })).toBe("2");
    expect(evaluate("q.page", { q: Object.assign(Object.create(null), { page: "2" }) })).toBe("2");
    expect(failure("q.page", { q: bag })).toBe("unsupported_container");
    expect(failure("'page' in q", { q: bag })).toBe("no_matching_overload");
    expect(evaluate("has(q.page)", { q: bag })).toBe(false);
  });

  it("answers absence for a presence-shaped read over a value that holds no members", () => {
    // The optional library's own semantics, which this engine takes from cel-go whole:
    // `.?`, `[?]` and `has()` ask whether a member is THERE, and a value that cannot hold
    // one has none to find.
    expect(evaluate("dyn('abc').?length.hasValue()")).toBe(false);
    expect(evaluate("dyn(1)[?'toString'].hasValue()")).toBe(false);
    expect(evaluate("has(dyn('abc').length)")).toBe(false);
    // The two readings it is asymmetric with, on purpose: the ORDINARY read of the same
    // member is the mistake it is outside an optional — including the ordinary step of a
    // chain that entered optional land, which is cel-spec's `map_present_key_invalid_field`
    // — and an unusable KEY is a mistake in the read itself, in every form.
    expect(failure("dyn('abc').length")).toBe("unsupported_container");
    expect(failure("{true: dyn(0)}[?true].absent")).toBe("unsupported_container");
    expect(failure("dyn([1, 2]).?length")).toBe("unsupported_key_type");
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
