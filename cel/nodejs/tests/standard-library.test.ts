import { describe, expect, it } from "vitest";
import { CelEnvironment } from "../src/environment.js";

/**
 * What the library declares, held to **cel-spec** rather than to any engine's recording.
 * Where the two differ, the recording is evidence and the specification decides; the rows
 * that differ are listed, with their authority, in the conformance driver.
 */

function language(): CelEnvironment {
  return new CelEnvironment({ unlistedVariablesAreDyn: true, enableOptionalTypes: true });
}

const typeOf = (source: string) => {
  const result = language().check(source);
  expect(result.diagnostics, source).toEqual([]);
  return result.typeName;
};

const refusal = (source: string) => {
  const result = language().check(source);
  expect(result.diagnostics.length, source).toBeGreaterThan(0);
  return result.diagnostics[0]!.code;
};

describe("the conversions", () => {
  it("converts between every pair cel-spec declares, the identities included", () => {
    expect([
      typeOf("int(42u)"),
      typeOf("int(timestamp('2004-09-16T23:59:59Z'))"),
      typeOf("int(duration('100s'))"),
      typeOf("string(timestamp('2004-09-16T23:59:59Z'))"),
      typeOf("string(duration('100s'))"),
      typeOf("duration(duration('100s'))"),
      typeOf("timestamp(timestamp(1000000000))"),
    ]).toEqual([
      "int",
      "int",
      "int",
      "string",
      "string",
      "google.protobuf.Duration",
      "google.protobuf.Timestamp",
    ]);
  });
});

describe("comparison", () => {
  it("orders every scalar type, bytes included", () => {
    for (const source of [
      "1 < 2",
      "1u < 2u",
      "1.0 < 2.0",
      "false < true",
      "'a' < 'b'",
      "b'a' < b'b'",
      "timestamp(1) < timestamp(2)",
      "duration('1s') < duration('2s')",
    ]) {
      expect(typeOf(source), source).toBe("bool");
    }
    expect(typeOf("b'a' >= b'b'")).toBe("bool");
  });

  it("orders across the numeric types and tests equality only within one", () => {
    expect(typeOf("1 < 2u")).toBe("bool");
    expect(typeOf("1.0 >= 2")).toBe("bool");
    // cel-spec's checker is strict about equality: its own suite writes dyn(1) == 2u.
    expect(refusal("1.0 == 1")).toBe("CEL_TYPE_ERROR");
    expect(refusal("2u != 2")).toBe("CEL_TYPE_ERROR");
    expect(typeOf("dyn(1.0) == 1")).toBe("bool");
  });

  it("compares a list and a map for equality, and does not order them", () => {
    expect(typeOf("[1] == [1]")).toBe("bool");
    expect(typeOf("{'a': 1} != {'a': 2}")).toBe("bool");
    expect(refusal("[1] < [2]")).toBe("CEL_TYPE_ERROR");
  });
});

describe("list concatenation", () => {
  it("answers the one element type both sides hold, and refuses two that share none", () => {
    expect(typeOf("[1, 2] + []")).toBe("list<int>");
    expect(typeOf("[] + [3, 4]")).toBe("list<int>");
    expect(typeOf("[] + []")).toBe("list");
    expect(typeOf("[1] + dyn([2])")).toBe("list<int>");
    // Taking the left operand's element type would answer `list<int>` here, for a list
    // that holds a string: the checker must not say something the value contradicts.
    expect(refusal("[1] + ['a']")).toBe("CEL_TYPE_ERROR");
  });
});

describe("the optional library", () => {
  it("enters whole: every member cel-spec declares is here", () => {
    expect([
      typeOf("optional.of(1)"),
      typeOf("optional.none()"),
      typeOf("optional.ofNonZeroValue(42)"),
      typeOf("optional.of(1).optMap(y, y + 1)"),
      typeOf("optional.of(1).optMap(y, string(y))"),
      typeOf("{'k': {'s': 'v'}}.?k.optFlatMap(k, k.?s)"),
      typeOf("optional.of(1) == optional.of(2)"),
      typeOf("optional.none() != optional.of(1)"),
      typeOf("type(optional.none()) == optional_type"),
    ]).toEqual([
      "optional<int>",
      "optional<dyn>",
      "optional<int>",
      "optional<int>",
      "optional<string>",
      "optional<string>",
      "bool",
      "bool",
      "bool",
    ]);
  });

  it("takes an optional from optFlatMap and nothing else", () => {
    expect(refusal("optional.of(1).optFlatMap(y, y + 1)")).toBe("CEL_TYPE_ERROR");
    expect(refusal("1.optMap(y, y)")).toBe("CEL_TYPE_ERROR");
  });

  it("has none of it where the option is off", () => {
    const off = new CelEnvironment({ unlistedVariablesAreDyn: true });
    for (const source of ["optional.of(1)", "optional.ofNonZeroValue(1)", "optional.of(1).optMap(y, y)"]) {
      expect(off.check(source).diagnostics[0]?.code, source).toBe("CEL_UNKNOWN_FUNCTION");
    }
    // The type name goes with them, so a site that declares everything legal refuses it.
    expect(new CelEnvironment().check("optional_type").diagnostics[0]?.code).toBe("CEL_UNKNOWN_IDENTIFIER");
    expect(new CelEnvironment({ enableOptionalTypes: true }).check("optional_type").typeName).toBe("type");
  });
});

describe("the optional library's own syntax", () => {
  it("holds an optional in an entry and contributes what it holds", () => {
    expect(typeOf("[?optional.of(1)]")).toBe("list<int>");
    expect(typeOf("[?optional.of(1), 2]")).toBe("list<int>");
    expect(typeOf("{?'k': optional.of('v')}")).toBe("map<string, string>");
    expect(typeOf("{?'k': optional.of('v'), 'j': 'w'}")).toBe("map<string, string>");
    expect(typeOf("[?{}.?c, ?optional.of(42)]")).toBe("list<int>");
    expect(typeOf("has({?'foo': optional.none()}.foo)")).toBe("bool");
  });

  it("refuses an entry written with ? that holds something else", () => {
    expect(refusal("[?1]")).toBe("CEL_TYPE_ERROR");
    expect(refusal("{?'k': 'v'}")).toBe("CEL_TYPE_ERROR");
  });
});

describe("a member read against a schema", () => {
  it("reaches a key no identifier can spell, which is what backticks are for", () => {
    const environment = new CelEnvironment().registerVariable("request", {
      schema: {
        type: "object",
        properties: {
          headers: {
            type: "object",
            properties: { "content-type": { type: "string" }, "content-length": { type: "integer" } },
          },
        },
      },
    });
    expect(environment.check("request.headers.`content-type`").typeName).toBe("string");
    expect(environment.check("request.headers.`content-length`").typeName).toBe("int");
    // The point of typing it: a typo in a key no identifier can spell is still caught.
    expect(environment.check("request.headers.`content-typo`").diagnostics[0]).toMatchObject({
      code: "CEL_UNKNOWN_FIELD",
      range: [16, 30],
    });
    expect(typeOf("{'a-b': 1}.`a-b`")).toBe("int");
  });
});

describe("has()", () => {
  it("asks about a member of anything whose last step is a select", () => {
    expect(typeOf("has({'a': 1}.a)")).toBe("bool");
    expect(typeOf("has({}.a)")).toBe("bool");
    expect(typeOf("has(a.b.c)")).toBe("bool");
    expect(typeOf("has(optional.of({'c': 1}).c)")).toBe("bool");
    expect(typeOf("has({'x': {'y': 1}}.?x.y)")).toBe("bool");
    // What it still refuses is an argument that is not a member read at all.
    expect(refusal("has(1)")).toBe("CEL_INVALID_ARGUMENT");
    expect(refusal("has(a)")).toBe("CEL_INVALID_ARGUMENT");
    expect(refusal("has(a[0])")).toBe("CEL_INVALID_ARGUMENT");
  });
});

describe("an unconstrained type variable", () => {
  it("behaves as dyn wherever it is used", () => {
    expect(typeOf("([].map(x, x))[0].foo")).toBe("dyn");
    expect(typeOf("[].map(x, x.map(y, y))")).toBe("list<list<dyn>>");
    expect(typeOf("[].map(i, i.map(j, j > 1))")).toBe("list<list<bool>>");
    expect(typeOf("optional.none().?anything.hasValue()")).toBe("bool");
    expect(typeOf("optional.none()[?0].hasValue()")).toBe("bool");
    expect(typeOf("{}.?absent.deeper.hasValue()")).toBe("bool");
    // And the type REPORTED for one is `dyn` too: a parameter nothing resolved says nothing
    // to whoever reads the answer, and it survives only where it is declared — a signature's
    // text, a nominal type's parameter list.
    expect(typeOf("[]")).toBe("list");
    expect(typeOf("{}")).toBe("map");
    expect(
      new CelEnvironment()
        .definitions()
        .functions.some((held) => held.signature.includes("list<A>")),
    ).toBe(true);
  });
});
