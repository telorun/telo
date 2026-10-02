import { describe, expect, it } from "vitest";
import { CelEnvironment } from "../src/environment.js";
import type { JsonSchemaNode } from "../src/json-schema-type.js";

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
