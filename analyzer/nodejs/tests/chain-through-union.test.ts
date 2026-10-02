import { describe, expect, it } from "vitest";
import { declaredDocument, navigateDeclaredChain } from "../src/referenced-shape.js";

/**
 * A plain chain that continues past a union is read in every alternative: its
 * declared shape is what the alternatives that can hold the member declare at
 * the chain's tail. Returning the union as the tail compared an object with the
 * member's slot and refused a correct read.
 */

type Schema = Record<string, any>;

const text = { type: "string" };
const integer = { type: "integer" };
const holding = (properties: Schema, more: Schema = {}) => ({ type: "object", properties, ...more });

/** What `chain` holds beneath a member `shape` declared as `shape`. */
const read = (shape: Schema, chain = "shape.a") => navigateDeclaredChain(holding({ shape }), chain);
const union = (...alternatives: unknown[]) => ({ anyOf: alternatives });

describe("a chain that continues past a union", () => {
  it("holds the one shape its alternatives agree on", () => {
    expect(read(union(holding({ a: text, kind: text }), holding({ a: text, other: text })))).toEqual(text);
  });

  it("holds the flat `anyOf` of what differing alternatives declare", () => {
    expect(read(union(holding({ a: text }), holding({ a: integer })))).toEqual({ anyOf: [text, integer] });
  });

  it("reads `oneOf` as it reads `anyOf`", () => {
    expect(read({ oneOf: [holding({ a: text }), holding({ a: integer })] })).toEqual({
      anyOf: [text, integer],
    });
  });

  it("drops a closed object that does not declare the member", () => {
    expect(
      read(union(holding({ a: text }), holding({ other: integer }, { additionalProperties: false }))),
    ).toEqual(text);
  });

  it.each([
    ["an open object without the member", holding({ other: text })],
    ["an untyped branch", { required: ["a"] }],
    ["a branch declaring only a schema for additional members", { type: "object", additionalProperties: text }],
    ["a branch declaring only an `allOf`", { allOf: [holding({ a: text })] }],
    ["a pattern-keyed object", holding({}, { additionalProperties: false, patternProperties: { "^a$": text } })],
  ])("claims nothing beside %s", (said, alternative) => {
    expect(read(union(holding({ a: text }), alternative))).toBeUndefined();
  });

  it.each([
    ["a `null` branch", { type: "null" }],
    ["a scalar", { type: ["integer", "null"] }],
    ["a constant of another value", { const: "none" }],
    ["an enum of other values", { enum: ["none", null] }],
    ["a value type over a scalar", { "x-telo-type": "Telo.TcpPort" }],
    ["an instance value type", { "x-telo-type": "Telo.Bytes" }],
    ["a branch admitting nothing", false],
  ])("drops %s, which leaves the tail as declared", (said, alternative) => {
    expect(read(union(alternative, holding({ a: text })))).toEqual(text);
  });

  it("claims nothing when no alternative can hold the member", () => {
    expect(read(union({ type: "null" }, text))).toBeUndefined();
  });

  it("distributes an alternative that is itself a union, and each union it crosses", () => {
    const inner = union(holding({ b: text }), holding({ b: integer }));
    const shape = union(holding({ a: inner }), union(holding({ a: holding({ b: text }) }), { type: "null" }));
    expect(read(shape, "shape.a.b")).toEqual({ anyOf: [text, integer] });
  });

  it("reads an index in every alternative", () => {
    const rows = (items: Schema) => ({ type: "array", items });
    expect(read(union(rows(holding({ a: text })), holding({ a: text }), { type: "null" }), "shape[0].a")).toEqual(text);
    expect(read(union(rows(holding({ a: text })), { type: "array" }), "shape[0].a")).toBeUndefined();
  });

  it("reads a union's own properties before its alternatives", () => {
    const shape = { ...holding({ a: text }), anyOf: [holding({ a: integer }), holding({ other: text })] };
    expect(read(shape)).toEqual(text);
  });

  it("splices a tail that is a bare union, so the result is one level deep", () => {
    const shape = union(
      holding({ a: { description: "either", anyOf: [text, { type: "null" }] } }),
      holding({ a: text }),
      holding({ a: integer }),
    );
    expect(read(shape)).toEqual({ anyOf: [text, { type: "null" }, integer] });
  });

  it("terminates on a shape that contains itself", () => {
    const tree = declaredDocument(
      holding({ value: text, next: union({ $ref: "#" }, { type: "null" }) }),
    );
    expect(navigateDeclaredChain(holding({ tree }), "tree.next.next.next.value")).toEqual(text);
  });
});

describe("an alternative behind a reference", () => {
  const named: Schema = {
    type: "object",
    properties: { a: { $ref: "#/$defs/Leaf" } },
    $defs: { Leaf: integer },
  };
  const external = (ref: string) => (ref === "telo:app/Named" ? named : undefined);

  /** `chain` read from a declared document whose `shape` is `alternatives`. */
  const inDocument = (alternatives: Schema[], $defs: Schema) =>
    navigateDeclaredChain(
      holding({ made: declaredDocument({ ...holding({ shape: union(...alternatives) }), $defs }) }),
      "made.shape.a",
      external,
    );

  it("is read as the shape it names, each against its own document's root", () => {
    expect(
      inDocument([{ $ref: "#/$defs/Local" }, { $ref: "telo:app/Named" }, { $ref: "#/$defs/Absent" }], {
        Local: holding({ a: { $ref: "#/$defs/Leaf" } }),
        Leaf: text,
        Absent: { type: "null" },
      }),
    ).toEqual({ anyOf: [text, integer] });
  });

  it.each([
    ["a named shape nothing resolves", [{ $ref: "telo:app/Unknown", type: "null" }], {}],
    [
      "a union already open",
      [{ $ref: "#/$defs/Loop" }],
      { Loop: union({ $ref: "#/$defs/Loop" }, holding({ a: text })) },
    ],
  ])("claims nothing through %s", (said, alternatives, $defs) => {
    expect(inDocument([holding({ a: text }), ...alternatives], $defs)).toBeUndefined();
  });

  it("claims nothing through a pointer whose document is not known, whatever is written beside it", () => {
    expect(read(union(holding({ a: text }), { $ref: "#/$defs/Other", type: "null" }))).toBeUndefined();
  });
});
