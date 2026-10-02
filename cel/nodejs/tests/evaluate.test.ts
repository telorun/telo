/**
 * Evaluation: the rules that hold wherever an expression is run.
 *
 * The conformance vectors pin the great majority of the semantics, row by row, but they
 * are driven by a separate gate that is handed a vectors directory. These are the rules
 * this package's own suite must prove with nothing else on disk — the ones the card names
 * and the ones no row reaches.
 */
import { describe, expect, it } from "vitest";
import { CEL_VALUE_TYPE, CelEnvironment, CelEvaluationError, celUint, type CelValue } from "../src/index.js";
import { BINDING_FORMS } from "../src/comprehension-bindings.js";

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

describe("evaluation", () => {
  it("makes an int64 overflow an error rather than a wrap", () => {
    expect(evaluate("9223372036854775807 - 1")).toBe(9223372036854775806n);
    expect(failure("9223372036854775807 + 1")).toBe("numeric_overflow");
    expect(failure("-9223372036854775808 - 1")).toBe("numeric_overflow");
    expect(failure("0u - 1u")).toBe("numeric_overflow");
    expect(failure("int(1e99)")).toBe("numeric_overflow");
  });

  it("names division and modulus by zero apart, and leaves a double to IEEE", () => {
    expect(failure("1 / 0")).toBe("division_by_zero");
    expect(failure("1 % 0")).toBe("modulo_by_zero");
    expect(failure("1u / 0u")).toBe("division_by_zero");
    expect(evaluate("1.0 / 0.0")).toBe(Number.POSITIVE_INFINITY);
  });

  it("carries an error through a short circuit, from either side", () => {
    expect(evaluate("false && {'a': 1}.b == 1")).toBe(false);
    expect(evaluate("{'a': 1}.b == 1 && false")).toBe(false);
    expect(evaluate("true || {'a': 1}.b == 1")).toBe(true);
    expect(evaluate("{'a': 1}.b == 1 || true")).toBe(true);
    expect(failure("true && {'a': 1}.b == 1")).toBe("no_such_key");
  });

  it("throws at the top of an evaluation, carrying the code and the range", () => {
    try {
      evaluate("1 + 9223372036854775807");
      throw new Error("it answered");
    } catch (cause) {
      expect(cause).toBeInstanceOf(CelEvaluationError);
      const failed = cause as CelEvaluationError;
      expect(failed.code).toBe("numeric_overflow");
      expect(failed.range).toEqual([0, 23]);
    }
  });

  it("converts a duration to an int, which no conformance row pins", () => {
    expect(evaluate("int(duration('90s'))")).toBe(90n);
    expect(evaluate("int(duration('1h30m'))")).toBe(5400n);
    // Truncated toward zero, as every conversion to an integer is.
    expect(evaluate("int(duration('-1.75s'))")).toBe(-1n);
    expect(evaluate("int(duration('0.5s'))")).toBe(0n);
  });

  it("holds a duration to the int64 range of its total nanoseconds, at every point one is built", () => {
    // The conversion, duration arithmetic both ways, and the span between two instants.
    expect(failure("duration('320000000000s')")).toBe("invalid_conversion");
    expect(failure("duration('9223372036s') + duration('1s')")).toBe("invalid_conversion");
    expect(failure("duration('-9223372036s') - duration('1s')")).toBe("invalid_conversion");
    expect(
      failure("timestamp('9999-12-31T23:59:59Z') - timestamp('0001-01-01T00:00:00Z')"),
    ).toBe("invalid_conversion");
    // And the duration OPERAND of timestamp arithmetic, which a host can hand over from the
    // wider range the typed frame carries.
    const wide = { span: { [CEL_VALUE_TYPE]: "google.protobuf.Duration", seconds: 200000000000n, nanos: 0 } };
    expect(failure("timestamp('2009-02-13T23:31:30Z') + span", wide)).toBe("invalid_conversion");
    expect(failure("span + timestamp('2009-02-13T23:31:30Z')", wide)).toBe("invalid_conversion");
    expect(failure("timestamp('2009-02-13T23:31:30Z') - span", wide)).toBe("invalid_conversion");
  });

  it("admits the widest duration there is, and nothing one nanosecond past it", () => {
    expect(evaluate("string(duration('9223372036.854775807s'))")).toBe("9223372036.854775807s");
    expect(evaluate("string(duration('-9223372036.854775808s'))")).toBe("-9223372036.854775808s");
    expect(failure("duration('9223372036.854775808s')")).toBe("invalid_conversion");
    expect(failure("duration('-9223372036.854775809s')")).toBe("invalid_conversion");
  });

  it("refuses an awaited value at every binding form the table declares", () => {
    // **Closed by the LIST, not by the cases someone happened to try.** The binding forms are
    // data (`BINDING_FORMS`), so a tenth one cannot be added without a probe here, and each
    // probe is written so that **no element decides the answer** — otherwise the engine's own
    // rule (a decided answer wins over an error, as in `||`) would make the probe pass without
    // the guard. Before this, `xs.all(e, true)` answered `true`: not a leaked value, a wrong
    // answer about a value nothing touched.
    const probes: Readonly<Record<string, string>> = {
      "all/2": "xs.all(e, true)",
      "exists/2": "xs.exists(e, false)",
      "exists_one/2": "xs.exists_one(e, true)",
      "filter/2": "xs.filter(e, true)",
      "map/2": "xs.map(e, e)",
      "map/3": "xs.map(e, true, e)",
      // A host may hand over the optional itself, so what it HOLDS is its own door.
      "optMap/2": "opt.optMap(v, v)",
      "optFlatMap/2": "opt.optFlatMap(v, optional.of(v))",
      "cel.bind/3": "cel.bind(v, held.a, 1)",
    };
    expect(Object.keys(probes).sort()).toEqual([...BINDING_FORMS].sort());
    const awaited = {
      xs: [Promise.resolve(1n), 2n],
      held: { a: Promise.resolve(1n) },
      opt: { [CEL_VALUE_TYPE]: "optional", present: true, held: Promise.resolve(1n) },
    };
    for (const [form, source] of Object.entries(probes)) {
      expect(failure(source, awaited), form).toBe("async_value_unsupported");
    }
    // Membership binds nothing and still reads every element, so it is a door of its own.
    expect(failure("1 in xs", awaited)).toBe("async_value_unsupported");
    // A comprehension over a MAP binds its keys, which are strings whatever the values are.
    expect(evaluate("m.all(k, k == 'k')", { m: { k: Promise.resolve(1n) } })).toBe(true);
  });

  it("refuses an awaited element whatever a readable element would have decided", () => {
    // **The refusal is TERMINAL — the one error here that does not short-circuit.** Carried as
    // an ordinary error it was DISCARDABLE, so the answer depended on which elements happened
    // to be readable: `[P, 2].all(e, false)` answered `false` and `[P, 2].exists(e, true)`
    // answered `true`, each off the one element it could read. A constant predicate hides this
    // (it exercises no binding) and a reference comparison exercises the binding without
    // touching the value, so both are probed here.
    const awaited = { xs: [Promise.resolve(1n), 2n] };
    for (const source of [
      "xs.all(e, false)",
      "xs.all(e, true)",
      "xs.all(e, e == e)",
      "xs.exists(e, true)",
      "xs.exists(e, false)",
      "xs.exists(e, e == e)",
      "xs.exists_one(e, e == e)",
      "xs.filter(e, e == e)",
      "xs.map(e, e == e)",
      "2 in xs",
    ]) {
      expect(failure(source, awaited), source).toBe("async_value_unsupported");
    }
    // **And the half that does NOT change**: an ordinary CEL error is a fact about one datum,
    // so a decided answer still outranks it, exactly as `true || <error>` is `true`.
    const rows = { ms: [{}, { a: 1n }] };
    expect(evaluate("ms.exists(e, e.a == 1)", rows)).toBe(true);
    expect(evaluate("ms.all(e, e.a == 2)", rows)).toBe(false);
  });

  it("does not walk a container, so what a host handed in it can be handed back", () => {
    // The boundary, stated: a thenable is refused where it becomes a value the engine
    // REASONS about. Nothing walks a container on the way past, because that would make
    // every read cost the size of what it returned — so `size` and a concatenation copy it
    // along, and every way of getting the element OUT is refused.
    const awaited = { xs: [Promise.resolve(1n), 2n] };
    expect(evaluate("size(xs)", awaited)).toBe(2n);
    expect((evaluate("xs + [3]", awaited) as readonly unknown[]).length).toBe(3);
    expect(failure("xs[0]", awaited)).toBe("async_value_unsupported");
    expect(failure("dyn(xs)[0]", awaited)).toBe("async_value_unsupported");
    expect(evaluate("xs[1]", awaited)).toBe(2n);
  });

  it("compares across the numeric types by CONVERTING, lossily, as cel-spec does", () => {
    // cel-spec's own corpus comments this case and names the test
    // `not_lt_dyn_int_big_lossy_double`: the int becomes a double, and the two doubles are
    // equal, so the comparison is false. Exactness is defensible alone and indefensible as a
    // cross-engine contract — a second engine on a conformant library would answer the other
    // way on a comparison that can decide an authorization or a retry bound.
    expect(evaluate("dyn(9223372036854775807) < 9223372036854775808.0")).toBe(false);
    expect(evaluate("dyn(9223372036854775807) == 9223372036854775808.0")).toBe(true);
    // Outside the integer type's range the SIGN decides, with no conversion to be lossy.
    expect(evaluate("dyn(1) < 1e308")).toBe(true);
    expect(evaluate("dyn(1) > -1e308")).toBe(true);
    expect(evaluate("dyn(1u) > -1.0")).toBe(true);
    // NaN orders with nothing, itself included.
    expect(evaluate("dyn(1) < 0.0/0.0")).toBe(false);
    expect(evaluate("dyn(1) > 0.0/0.0")).toBe(false);
    // The ordinary cross-numeric answers are unchanged by any of it.
    expect(evaluate("dyn(1) == 1.0")).toBe(true);
    expect(evaluate("dyn(1) == 1u")).toBe(true);
    expect(evaluate("dyn(2) < 3u")).toBe(true);
  });

  it("refuses a double at or beyond EITHER int64 extreme, which is the same rule", () => {
    // Both ends of one range must behave the same way: the nearest double to each extreme is
    // outside it, so neither converts.
    expect(failure("int(9223372036854775807.0)")).toBe("numeric_overflow");
    expect(failure("int(-9223372036854775808.0)")).toBe("numeric_overflow");
    expect(failure("int(9223372036854775808.0)")).toBe("numeric_overflow");
    expect(failure("int(-9223372036854775809.0)")).toBe("numeric_overflow");
    // And the largest double that IS inside it converts.
    expect(evaluate("int(9223372036854774784.0)")).toBe(9223372036854774784n);
    expect(evaluate("int(-9223372036854774784.0)")).toBe(-9223372036854774784n);
  });

  it("splits a duration's getters: the whole span, but getMilliseconds is the component", () => {
    // cel-spec's split, and the only one under which the engine does not contradict itself —
    // a timestamp's getMilliseconds has always answered the component.
    expect(evaluate("duration('123.321456789s').getMilliseconds()")).toBe(321n);
    expect(evaluate("duration('123.321456789s').getSeconds()")).toBe(123n);
    expect(evaluate("duration('1h30m').getMinutes()")).toBe(90n);
    expect(evaluate("duration('1h30m').getHours()")).toBe(1n);
    expect(evaluate("duration('1h30m').getSeconds()")).toBe(5400n);
    expect(evaluate("duration('-1.5s').getMilliseconds()")).toBe(-500n);
    expect(evaluate("timestamp('2009-02-13T23:31:30.321Z').getMilliseconds()")).toBe(321n);
  });

  it("answers the compatibility members as their own declarations say, not as the extension would", () => {
    // Each of these differences is what the member's `spec: false` reason states, and the
    // cutover must not change any of them: a manifest is written against this behaviour.
    expect(evaluate("'TacoCÆt'.lowerAscii()")).toBe("tacocæt");
    expect(evaluate("'tacoCαt'.upperAscii()")).toBe("TACOCΑT");
    // Indices are UTF-16 code units: a character outside the basic plane takes two.
    expect(evaluate("'a😀b'.indexOf('b')")).toBe(3n);
    expect(evaluate("'a😀b'.substring(1, 3)")).toBe("😀");
    // While `size` is CEL's own, and counts characters.
    expect(evaluate("size('a😀b')")).toBe(3n);
  });

  it("refuses a value that must be awaited, rather than passing it along", () => {
    expect(failure("held.a", { held: Promise.resolve({ a: 1n }) })).toBe("async_value_unsupported");
    // Nested, which is the shape a host actually hands over: read at the top of an
    // expression, and read as an operand.
    const nested = { held: { a: Promise.resolve(1n) } };
    expect(failure("held.a", nested)).toBe("async_value_unsupported");
    expect(failure("held.a + 1", nested)).toBe("async_value_unsupported");
    expect(failure("[held.a][0]", nested)).toBe("async_value_unsupported");
    // **The BARE aggregate forms are the ones that escaped**: reading the element back out
    // reached the guard, while a list or a map that merely HOLDS the read answered a
    // container with the promise still in it. `!cel "[resources.x.status.p]"` is that shape.
    expect(failure("[held.a]", nested)).toBe("async_value_unsupported");
    expect(failure("{'k': held.a}", nested)).toBe("async_value_unsupported");
    expect(failure("held['a']", nested)).toBe("async_value_unsupported");
    const optional = new CelEnvironment({
      unlistedVariablesAreDyn: true,
      enableOptionalTypes: true,
    });
    expect(() => optional.evaluate("[?optional.of(held).a]", nested)).toThrow(/synchronously/);
    expect(() => optional.evaluate("held.?a.hasValue()", nested)).toThrow(/synchronously/);
    const answers = new CelEnvironment({ unlistedVariablesAreDyn: true }).registerFunction(
      "later(): string",
      // A host whose answer is asynchronous registers nothing; one that does is refused
      // here rather than leaking a promise into the expression.
      { implementation: () => Promise.resolve("too late") as never },
    );
    expect(() => answers.evaluate("later()")).toThrow(/synchronously/);
  });

  it("matches on RE2, and refuses a pattern RE2 does not read", () => {
    expect(evaluate("'abc'.matches('b')")).toBe(true);
    expect(evaluate("'abc'.matches('^a.c$')")).toBe(true);
    // A backreference is the host language's regular expressions, not RE2's.
    expect(failure("'aa'.matches('(a)\\\\1')")).toBe("invalid_regular_expression");
    expect(failure("'abc'.matches('(')")).toBe("invalid_regular_expression");
  });

  it("reads a field of an instant in a zone, named or written as an offset", () => {
    expect(evaluate("timestamp('2009-02-13T23:31:30Z').getHours()")).toBe(23n);
    expect(evaluate("timestamp('2009-02-13T23:31:30Z').getHours('02:00')")).toBe(1n);
    expect(evaluate("timestamp('2009-02-13T23:31:30Z').getHours('-08:00')")).toBe(15n);
    expect(evaluate("timestamp('2009-02-13T23:31:30Z').getFullYear('Australia/Sydney')")).toBe(2009n);
    expect(evaluate("timestamp('2009-02-13T23:31:30Z').getDayOfMonth('Australia/Sydney')")).toBe(13n);
    expect(failure("timestamp('2009-02-13T23:31:30Z').getHours('Mars/Olympus')")).toBe("invalid_argument");
  });

  it("searches the activation for an undeclared dotted chain, longest prefix first", () => {
    // Nothing is declared here, so there is nothing to split the chain on and the checker has
    // no opinion: the activation decides at evaluation. Every conformance row binding a dotted
    // key reads this way.
    expect(evaluate("a.b.c", { "a.b.c": "the variable" })).toBe("the variable");
    expect(evaluate("a.b.c", { "a.b": { c: "the entry" } })).toBe("the entry");
    expect(evaluate("a.b.c", { a: { b: { c: "the nested entry" } } })).toBe("the nested entry");
    expect(evaluate("a.b.c", { "a.b.c": "the variable", "a.b": { c: "the entry" } })).toBe("the variable");
  });

  it("splits a DECLARED dotted chain where the declaration says, and reads that one name", () => {
    const declaring = (name: string, type: string) =>
      new CelEnvironment({ unlistedVariablesAreDyn: true }).registerVariable(name, type);
    // The longest declared prefix wins, and the checker typed the same split.
    expect(declaring("a.b.c", "string").evaluate("a.b.c", { "a.b.c": "the variable" })).toBe(
      "the variable",
    );
    expect(
      declaring("a.b", "map<string, string>").evaluate("a.b.c", { "a.b": { c: "the entry" } }),
    ).toBe("the entry");
    // A declared name the activation does not hold fails for THAT name — never by falling back
    // to a shorter prefix, which would read a value of a name the host did not mean.
    const held = declaring("a.b.c", "string");
    try {
      held.evaluate("a.b.c", { "a.b": { c: "the entry" } });
      throw new Error("it answered");
    } catch (cause) {
      expect((cause as CelEvaluationError).code).toBe("no_such_variable");
      expect((cause as CelEvaluationError).message).toContain("a.b.c");
    }
  });

  it("reads an absolute name against the activation, past a name a comprehension bound", () => {
    expect(evaluate("['compre'].exists(y, .y == 'outer')", { y: "outer" })).toBe(true);
    expect(evaluate("['compre'].exists(y, y == 'compre')", { y: "outer" })).toBe(true);
  });

  it("evaluates every comprehension macro, and `cel.bind`", () => {
    expect(evaluate("[1, 2, 3].all(i, i > 0)")).toBe(true);
    expect(evaluate("[1, 2, 3].exists(i, i == 2)")).toBe(true);
    expect(evaluate("[1, 2, 3].exists_one(i, i == 2)")).toBe(true);
    expect(evaluate("[1, 2, 3].filter(i, i > 1)")).toEqual([2n, 3n]);
    expect(evaluate("[1, 2, 3].map(i, i * 2)")).toEqual([2n, 4n, 6n]);
    expect(evaluate("[1, 2, 3].map(i, i > 1, i * 2)")).toEqual([4n, 6n]);
    expect(evaluate("{'a': 1, 'b': 2}.map(k, k)")).toEqual(["a", "b"]);
    expect(evaluate("cel.bind(x, 2, x * x)")).toBe(4n);
    // A decided answer wins over an error, as it does in `&&`.
    expect(evaluate("[1, 'two'].exists(i, i == 1)")).toBe(true);
  });

  it("keeps a uint, an int and a double apart while computing across them", () => {
    expect(evaluate("1u + 1u")).toEqual(celUint(2n));
    expect(evaluate("type(1u) == uint")).toBe(true);
    expect(evaluate("dyn(1) == 1u")).toBe(true);
    expect(evaluate("dyn(1.0) == 1")).toBe(true);
    expect(failure("dyn(1) + 1u")).toBe("no_matching_overload");
  });

  it("compiles to one program per source text, and forgets the oldest past its capacity", () => {
    const held = new CelEnvironment({ compiledCacheCapacity: 2 });
    const first = held.compile("1 + 1");
    expect(held.compile("1 + 1")).toBe(first);
    held.compile("2 + 2");
    held.compile("3 + 3");
    expect(held.compile("1 + 1")).not.toBe(first);
  });
});
