import { describe, expect, it } from "vitest";
import { declaredScalarPaths, defaultBearingPaths, reachesMembersSlot } from "../src/index.js";

// A recursive shape reaching itself through many distinct `$ref` objects, the
// way the draft-07 meta-schema does: a walk cutting only at a repeated `$ref`
// object descends once per distinct reference and grows factorially.
const SELF_REFERENCES = 14;

function recursiveContract(): Record<string, any> {
  const properties: Record<string, any> = { leaf: { type: "integer", default: 1 } };
  for (let i = 0; i < SELF_REFERENCES; i++) properties[`p${i}`] = { $ref: "#/$defs/Node" };
  return {
    $ref: "#/$defs/Node",
    $defs: {
      Node: {
        type: "object",
        properties,
        additionalProperties: { $ref: "#/$defs/Node" },
        items: { $ref: "#/$defs/Node" },
        anyOf: [{ $ref: "#/$defs/Node" }, { type: "null" }],
      },
    },
  };
}

function viaNamedShape(): { schema: Record<string, any>; resolveRef: (ref: string) => any } {
  const node = recursiveContract().$defs.Node;
  const rewritten = JSON.parse(JSON.stringify(node).replaceAll("#/$defs/Node", "telo:Acme/Node"));
  return { schema: { $ref: "telo:Acme/Node" }, resolveRef: (ref) => (ref === "telo:Acme/Node" ? rewritten : undefined) };
}

describe("contract walks stop where a recursive shape re-enters itself", () => {
  it("defaultBearingPaths", () => {
    expect(defaultBearingPaths(recursiveContract())).toEqual([["leaf"]]);
    const { schema, resolveRef } = viaNamedShape();
    expect(defaultBearingPaths(schema, resolveRef)).toEqual([["leaf"]]);
  });

  it("declaredScalarPaths", () => {
    expect(declaredScalarPaths(recursiveContract())).toEqual([{ path: ["leaf"], form: "int64" }]);
    const { schema, resolveRef } = viaNamedShape();
    expect(declaredScalarPaths(schema, resolveRef)).toEqual([{ path: ["leaf"], form: "int64" }]);
  });

  it("reachesMembersSlot", () => {
    expect(reachesMembersSlot(recursiveContract())).toBe(false);
    const { schema, resolveRef } = viaNamedShape();
    expect(reachesMembersSlot(schema, resolveRef)).toBe(false);
  });
});
