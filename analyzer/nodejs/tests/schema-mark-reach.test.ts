import { describe, expect, it } from "vitest";
import { sensitivePaths } from "../src/invocation-contract.js";
import { spanAttributePaths } from "../src/span-attribute.js";

/**
 * A recursive union of `width` node kinds, each holding a list of any node and
 * a few fields shaped by one shared named shape — the shape a UI node tree has,
 * where a walk guarded only along its own path visits each shape once per path.
 */
function nodeTree(width: number, marks: { sensitive?: boolean; span?: boolean } = {}) {
  const shapes: Record<string, Record<string, any>> = {
    "telo:Acme/Field": {
      type: "object",
      properties: {
        label: { type: "string" },
        secret: marks.sensitive ? { type: "string", "x-telo-sensitive": true } : { type: "string" },
      },
    },
    "telo:Acme/Node": { anyOf: [] as Record<string, any>[] },
  };
  for (let i = 0; i < width; i++) {
    shapes["telo:Acme/Node"]!.anyOf.push({ $ref: `telo:Acme/Kind${i}` });
    shapes[`telo:Acme/Kind${i}`] = {
      type: "object",
      properties: {
        type: { const: `kind${i}` },
        field: { $ref: "telo:Acme/Field" },
        children: { type: "array", items: { $ref: "telo:Acme/Node" } },
      },
    };
  }
  const schema: Record<string, any> = {
    type: "object",
    properties: {
      id: marks.span ? { type: "string", "x-telo-span-attribute": "acme.id" } : { type: "string" },
      node: { $ref: "telo:Acme/Node" },
    },
  };
  let lookups = 0;
  const resolveRef = (ref: string) => {
    lookups++;
    return shapes[ref];
  };
  return { schema, resolveRef, lookups: () => lookups };
}

describe("the contract walks over a recursive union", () => {
  it("stay linear in the schema graph when no subtree holds a mark", () => {
    const tree = nodeTree(12);
    expect(sensitivePaths(tree.schema, tree.resolveRef)).toEqual([]);
    expect(spanAttributePaths(tree.schema, tree.resolveRef).attributes).toEqual([]);
    // Without pruning each walk resolved Kind<i> once per path through the union,
    // which grows factorially with the width.
    expect(tree.lookups()).toBeLessThan(200);
  });

  it("still find a mark every node kind reaches through a shared shape", () => {
    const tree = nodeTree(2, { sensitive: true, span: true });
    // Once per node kind, each reaching the shared shape; the walk stops where the
    // union closes on itself.
    expect(sensitivePaths(tree.schema, tree.resolveRef)).toEqual([
      ["node", "field", "secret"],
      ["node", "field", "secret"],
    ]);
    expect(spanAttributePaths(tree.schema, tree.resolveRef).attributes).toEqual([
      { path: ["id"], name: "acme.id" },
    ]);
  });
});
