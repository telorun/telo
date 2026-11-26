import { describe, expect, it } from "vitest";
import { CelEnvironment } from "../src/environment.js";
import { TYPE_TEXT_NODE_LIMIT, type RecordType } from "../src/cel-type.js";
import { readSchemaType, type JsonSchemaNode } from "../src/json-schema-type.js";
import { SchemaDependencyRecorder } from "../src/schema-dependencies.js";
import { typeVisits } from "../src/type-visits.js";

/**
 * The bound: **checking does not get more expensive as a schema gets deeper.**
 *
 * Deep typing is new, and the checker runs at every keystroke in an editor, so a cost
 * that grew with the depth of the schema a host registered would be discovered by a user
 * rather than by us. The property that makes it hold is that a schema is converted to a
 * type **once, at registration**, and a check then walks the expression alone — so the
 * same expression costs the same against a 4-deep schema and a 64-deep one.
 *
 * **It is asserted as WORK, never as elapsed time.** This file used to divide two
 * wall-clock measurements and require the ratio to stay under 2, which failed on a loaded
 * CI runner at 2.37 — a machine's noise, not a regression: both numbers are small, the
 * denominator is the faster one, and nothing about the schema moved. A ratio of two
 * timings is still a measurement of a machine. What the property actually rests on is
 * countable and exact: a schema is read at registration and **never** during a check, so
 * per-check work is independent of depth by construction. Counting the reads proves that
 * at any depth, on any machine, and fails for the one cause a timing ratio was reaching
 * for — a checker that re-walks the schema per check.
 */

/** A schema `depth` levels deep, each level holding `width` properties. */
function deepSchema(depth: number, width: number): JsonSchemaNode {
  let node: JsonSchemaNode = { type: "object", properties: { leaf: { type: "string" } } };
  for (let level = 0; level < depth; level += 1) {
    const properties: Record<string, JsonSchemaNode> = { next: node };
    for (let at = 0; at < width; at += 1) properties[`field${at}`] = { type: "integer" };
    node = { type: "object", properties };
  }
  return node;
}

/** Schema nodes read across 100 checks, once registration has already read the schema.
 *  Zero is the property: a check walks the expression, never the schema behind it. */
function schemaReadsPerCheck(schema: JsonSchemaNode, source: string): number {
  let nodesRead = 0;
  const environment = new CelEnvironment({
    resolveSchemaType: () => {
      nodesRead += 1;
      return undefined;
    },
  }).registerVariable("subject", { schema });
  expect(environment.check(source).valid, source).toBe(true);
  const afterRegistration = nodesRead;
  expect(afterRegistration, "registration must read the schema").toBeGreaterThan(0);
  for (let run = 0; run < 100; run += 1) environment.check(source);
  return nodesRead - afterRegistration;
}

describe("the cost of checking against a schema", () => {
  it("does not grow with the depth of the schema", () => {
    const source = "subject.next.next.field0 + subject.field1";
    // Per-check work at depth 4 and at depth 64. The deep schema holds 16 times as many
    // nodes, so a checker that touched the schema per check would read 16 times as much.
    const shallow = schemaReadsPerCheck(deepSchema(4, 16), source);
    const deep = schemaReadsPerCheck(deepSchema(64, 16), source);
    expect(shallow).toBe(0);
    expect(deep).toBe(0);
    expect(deep).toBe(shallow);
  });

  it("converts a schema once per registration, however often it is checked against", () => {
    const schema = deepSchema(64, 16);
    let nodesRead = 0;
    const environment = new CelEnvironment({
      resolveSchemaType: () => {
        nodesRead += 1;
        return undefined;
      },
    }).registerVariable("subject", { schema });
    const afterRegistration = nodesRead;
    expect(afterRegistration).toBeGreaterThan(1000);
    for (let run = 0; run < 100; run += 1) environment.check("subject.next.leaf");
    expect(nodesRead).toBe(afterRegistration);
  });
});

/**
 * The same schema, composed the way a real one is: every level reached through a
 * document-local reference and merged out of two `allOf` halves. The bound has to hold
 * with resolution in the path, or "once per registration" is only true of the easy shape.
 */
function deepReferencedSchema(depth: number, width: number): JsonSchemaNode {
  const defs: Record<string, JsonSchemaNode> = {
    leaf: { type: "object", properties: { leaf: { type: "string" } } },
  };
  let previous = "leaf";
  for (let level = 0; level < depth; level += 1) {
    const fields: Record<string, JsonSchemaNode> = {};
    for (let at = 0; at < width; at += 1) fields[`field${at}`] = { type: "integer" };
    defs[`level${level}`] = {
      allOf: [
        { type: "object", properties: { next: { $ref: `#/$defs/${previous}` } } },
        { type: "object", properties: fields },
      ],
    };
    previous = `level${level}`;
  }
  return { $ref: `#/$defs/${previous}`, $defs: defs };
}

describe("the cost of checking against a schema of references", () => {
  it("does not grow with the depth of the schema", () => {
    const source = "subject.next.next.field0 + subject.field1";
    // With resolution in the path, or "once per registration" is only true of the easy shape.
    const shallow = schemaReadsPerCheck(deepReferencedSchema(4, 16), source);
    const deep = schemaReadsPerCheck(deepReferencedSchema(64, 16), source);
    expect(shallow).toBe(0);
    expect(deep).toBe(0);
    expect(deep).toBe(shallow);
  });

  it("resolves and converts once per registration, however often it is checked against", () => {
    const schema = deepReferencedSchema(64, 16);
    let nodesRead = 0;
    const environment = new CelEnvironment({
      resolveSchemaType: () => {
        nodesRead += 1;
        return undefined;
      },
    }).registerVariable("subject", { schema });
    const afterRegistration = nodesRead;
    expect(afterRegistration).toBeGreaterThan(1000);
    expect(environment.check("subject.next.next.field0").typeName).toBe("int");
    for (let run = 0; run < 100; run += 1) environment.check("subject.next.leaf");
    expect(nodesRead).toBe(afterRegistration);
  });

  it("converts a shape referenced many times once, so the cost is in the nodes reached", () => {
    const shape: JsonSchemaNode = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "integer" }, c: { type: "boolean" } },
    };
    const properties: Record<string, JsonSchemaNode> = {};
    for (let at = 0; at < 50; at += 1) properties[`held${at}`] = { $ref: "#/$defs/Shape" };
    let shapeNodesRead = 0;
    const environment = new CelEnvironment({
      resolveSchemaType: ({ node }) => {
        if (node === shape || Object.values(shape.properties!).includes(node as JsonSchemaNode)) {
          shapeNodesRead += 1;
        }
        return undefined;
      },
    }).registerVariable("subject", {
      schema: { type: "object", properties, $defs: { Shape: shape } },
    });
    // The shape and its three fields, once — not once per reference.
    expect(shapeNodesRead).toBe(4);
    expect(environment.check("subject.held49.c").typeName).toBe("bool");
  });
});

/**
 * The cost of registering an intersection, counted rather than timed: the holders the containers
 * its meets built keep (`heldHolders`), the containers built (`builtContainers`, each once however
 * many meets answered it) and the entries of the readings built (`readsEntries`) — and the cost
 * of listing what a read of the met type rests on, as the reading entries the listing steps
 * through. Each grows linearly with depth: doubling the depth at most multiplies it by 2.5.
 */
describe("the cost of converting an intersection", () => {
  const leaf = (): JsonSchemaNode => ({ type: "object", properties: { v: { type: "string" } } });

  /** `depth` levels, each an `allOf` of two halves reaching the level below through one reference. */
  function diamond(depth: number): JsonSchemaNode {
    const defs: Record<string, JsonSchemaNode> = { d0: leaf() };
    for (let level = 1; level <= depth; level += 1) {
      const half: JsonSchemaNode = { properties: { a: { $ref: `#/$defs/d${level - 1}` } } };
      defs[`d${level}`] = { allOf: [half, { ...half }] };
    }
    return { $defs: defs, $ref: `#/$defs/d${depth}` };
  }

  /** Two chains of equal content, each level of either an `allOf` of the two levels below. */
  function twoChains(depth: number): JsonSchemaNode {
    const defs: Record<string, JsonSchemaNode> = { d0: leaf(), e0: leaf() };
    const half = (name: string, level: number): JsonSchemaNode => ({ properties: { a: { $ref: `#/$defs/${name}${level - 1}` } } });
    for (let level = 1; level <= depth; level += 1) {
      defs[`d${level}`] = { allOf: [half("d", level), half("e", level)] };
      defs[`e${level}`] = { allOf: [half("e", level), half("d", level)] };
    }
    return { $defs: defs, $ref: `#/$defs/d${depth}` };
  }

  /** As {@link diamond}, each half a union of two shapes reaching the level below. */
  function unionDiamond(depth: number): JsonSchemaNode {
    const defs: Record<string, JsonSchemaNode> = { d0: leaf() };
    for (let level = 1; level <= depth; level += 1) {
      const below = { $ref: `#/$defs/d${level - 1}` };
      const half = (): JsonSchemaNode => ({
        oneOf: [{ properties: { a: { ...below } } }, { properties: { a: { ...below }, b: { type: "string" } } }],
      });
      defs[`d${level}`] = { allOf: [half(), half()] };
    }
    return { $defs: defs, $ref: `#/$defs/d${depth}` };
  }

  /** An `allOf` of `count` parts, each a union of two shapes differing only in a constant. */
  function unions(count: number): JsonSchemaNode {
    const parts: JsonSchemaNode[] = [];
    for (let at = 0; at < count; at += 1) {
      const key = `k${at}`;
      parts.push({ anyOf: [{ type: "object", properties: { [key]: { const: "a" } } }, { type: "object", properties: { [key]: { const: "b" } } }] });
    }
    return { allOf: parts };
  }

  /** The reading entries listing `x.a…a.v` steps through, the chain as deep as the fixture. */
  function listed(node: JsonSchemaNode, depth: number): number {
    const { result, provenance } = readSchemaType({ node });
    const recorder = new SchemaDependencyRecorder();
    recorder.readRegistration(provenance);
    let type = result.type;
    for (let level = 0; level < depth; level += 1) {
      recorder.readMember(type, "a");
      type = (type as RecordType).fields.get("a")!;
    }
    recorder.readMember(type, "v");
    return recorder.visited;
  }

  const counters = {
    heldHolders: (node: JsonSchemaNode) => readSchemaType({ node }).heldHolders,
    builtContainers: (node: JsonSchemaNode) => readSchemaType({ node }).builtContainers,
    readsEntries: (node: JsonSchemaNode) => readSchemaType({ node }).readsEntries,
  };

  for (const [fixture, build] of [
    ["a level meeting the level below with itself", diamond],
    ["a level meeting two chains of equal content", twoChains],
    ["a level meeting two unions of the level below", unionDiamond],
  ] as const) {
    for (const [counter, count] of Object.entries(counters)) {
      it(`counts ${counter} linear in depth for ${fixture}`, () => {
        expect(count(build(32))).toBeLessThanOrEqual(2.5 * count(build(16)));
        expect(count(build(16))).toBeLessThanOrEqual(2.5 * count(build(8)));
      });
    }

    if (build === unionDiamond) continue;
    it(`lists a read through ${fixture} in steps linear in its depth`, () => {
      expect(listed(build(32), 32)).toBeLessThanOrEqual(2.5 * listed(build(16), 16));
      expect(listed(build(16), 16)).toBeLessThanOrEqual(2.5 * listed(build(8), 8));
    });
  }

  it("stops building union members past the expansion limit", () => {
    // Six parts build 64 members, the limit; the seventh would build 128, so it and every
    // part after it add no member.
    expect(counters.heldHolders(unions(8))).toBe(counters.heldHolders(unions(7)));
    expect(counters.heldHolders(unions(7))).toBe(counters.heldHolders(unions(6)));
  });
});

/**
 * The cost of the walks a check makes over a whole type, counted as type visits rather than
 * timed: a reference is read once, so the type of `d_i` holds the type of `d_{i-1}` twice, and
 * a walk answering each type object once visits a number of types linear in the depth where
 * one walking every path visits `2^depth`. The count covers the conversion at registration
 * and the check, listing and locating included.
 */
describe("the cost of walking a shared type", () => {
  /** `depth` levels, each a record whose two fields reach the level below through one reference. */
  function binary(depth: number): JsonSchemaNode {
    const defs: Record<string, JsonSchemaNode> = { d0: { type: "object", properties: { v: { type: "string" } } } };
    for (let level = 1; level <= depth; level += 1) {
      const below = `#/$defs/d${level - 1}`;
      defs[`d${level}`] = { type: "object", properties: { a: { $ref: below }, b: { $ref: below } } };
    }
    return { $defs: defs, $ref: `#/$defs/d${depth}` };
  }

  /** The types registering `binary(depth)` and checking `source` against it visit. */
  function visits(depth: number, source: string): number {
    const before = typeVisits();
    const environment = new CelEnvironment().registerVariable("x", { schema: binary(depth) });
    expect(environment.check(source, { schemaDependencies: true, schemaNodes: true }).typeName).toBe("map");
    return typeVisits() - before;
  }

  for (const source of ["x", "x.a.b.a"]) {
    it(`visits each distinct type once checking ${source}`, () => {
      // The smaller depth is measured first, so a walk of every path fails at 24 rather than running 48.
      const atTwelve = visits(12, source);
      const atTwentyFour = visits(24, source);
      expect(atTwentyFour).toBeLessThanOrEqual(2.5 * atTwelve);
      expect(visits(48, source)).toBeLessThanOrEqual(2.5 * atTwentyFour);
      // Reached only once the bound holds: walking every path, depth 64 never completes.
      if (source === "x") expect(visits(64, source)).toBeGreaterThan(0);
    });
  }
});

/**
 * The cost of printing a type: the type of `d_i`, a union of a list and a map of `d_{i-1}`,
 * holds `2^i` nodes printed whole, so a printed type is cut at `TYPE_TEXT_NODE_LIMIT` nodes —
 * its text writes that many type names and `...` however deep the type goes. Its length is
 * bounded rather than equal: which names the first nodes are depends on the depth.
 */
describe("the cost of printing a type", () => {
  /** `depth` levels, each a union of an array and an object of the level below. */
  function arrayObjectDiamond(depth: number): JsonSchemaNode {
    const defs: Record<string, JsonSchemaNode> = { d0: { type: "string" } };
    for (let level = 1; level <= depth; level += 1) {
      const below = { $ref: `#/$defs/d${level - 1}` };
      defs[`d${level}`] = { oneOf: [{ type: "array", items: below }, { type: "object", additionalProperties: below }] };
    }
    return { $defs: defs, $ref: `#/$defs/d${depth}` };
  }

  /** The longest text the cut can write here: every node a `map<string, ` opening, then `...` and the brackets it closes. */
  const PRINTED_LENGTH_BOUND = TYPE_TEXT_NODE_LIMIT * "map<string, ".length + "...".length + TYPE_TEXT_NODE_LIMIT;

  /** The printed type's text writes exactly the limit's type nodes, then one `...` and only closing brackets. */
  function expectCut(text: string, at: string): void {
    expect(text.match(/list|map|string/g)?.length, at).toBe(TYPE_TEXT_NODE_LIMIT);
    expect(text.split("...").length, at).toBe(2);
    expect(text.slice(text.indexOf("...") + "...".length), at).toMatch(/^>*$/);
    expect(text.length, at).toBeLessThanOrEqual(PRINTED_LENGTH_BOUND);
  }

  const printed = (depth: number) =>
    new CelEnvironment().registerVariable("x", { schema: arrayObjectDiamond(depth) }).check("x", { schemaDependencies: true, schemaNodes: true }).typeName;

  it("writes as many type nodes at any depth, then cuts", () => {
    // Each depth is judged before the next is printed, so printing every node fails at 16.
    for (const depth of [16, 32, 64]) expectCut(printed(depth), `depth ${depth}`);
  });

  /** An environment declaring `Ns.f`, its result the diamond declared as a schema. */
  const declaringResult = (depth: number) =>
    new CelEnvironment().registerNamespace("Ns", [{ name: "f", returns: { schema: arrayObjectDiamond(depth) } }]);

  it("lists a result declared as a schema in bounded text, and digests it in work linear in its depth", () => {
    for (const depth of [16, 32, 64]) {
      const [listed] = declaringResult(depth).definitions().namespaces[0]!.functions;
      expect(listed!.declaration.startsWith("f(…): "), `depth ${depth}`).toBe(true);
      expectCut(listed!.declaration.slice("f(…): ".length), `depth ${depth}`);
    }
    const digested = (depth: number) => {
      const environment = declaringResult(depth);
      const before = typeVisits();
      environment.digest();
      return typeVisits() - before;
    };
    const [sixteen, thirtyTwo, sixtyFour] = [16, 32, 64].map(digested);
    expect(thirtyTwo).toBeLessThanOrEqual(2.5 * sixteen!);
    expect(sixtyFour).toBeLessThanOrEqual(2.5 * thirtyTwo!);
  });

  it("digests two results that differ past where their text is cut as two environments", () => {
    const deep = arrayObjectDiamond(64);
    const other = { ...deep, $defs: { ...(deep.$defs as Record<string, JsonSchemaNode>), d0: { type: "integer" } } };
    const [one, two] = [deep, other].map((schema) => new CelEnvironment().registerNamespace("Ns", [{ name: "f", returns: { schema } }]));
    const declarations = (environment: CelEnvironment) => environment.definitions().namespaces[0]!.functions.map((listed) => listed.declaration);
    expect(declarations(one!)).toEqual(declarations(two!));
    expect(one!.digest()).not.toBe(two!.digest());
  });
});
