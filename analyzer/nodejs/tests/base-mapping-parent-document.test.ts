import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** The `base:` findings of a child over `parentSchema`, with their paths. */
function baseFindings(parentSchema: Record<string, unknown>, base: Record<string, unknown>) {
  const parent = {
    kind: "Telo.Definition",
    metadata: { name: "Parent", module: "Test" },
    capability: "Telo.Invocable",
    schema: parentSchema,
  };
  const child = {
    kind: "Telo.Definition",
    metadata: { name: "Child", module: "Test" },
    extends: "Test.Parent",
    schema: { type: "object" },
    base,
  };
  const module = { kind: "Telo.Application", metadata: { name: "Test" } };
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions([module, parent, child] as unknown as ResourceManifest[]))
    .filter((d) => d.severity === 1)
    .map((d) => ({ code: d.code, path: (d.data as { path?: string } | undefined)?.path, message: d.message }));
}

describe("a base: field is validated where it sits in the parent's schema", () => {
  const tree = { type: "object", properties: { tree: { type: "object", $ref: "#" } } };

  it("reads '#' as the parent's root, so a value that root accepts is clean", () => {
    expect(baseFindings(tree, { tree: { leaf: 1 } })).toEqual([]);
  });

  it("refuses a value the parent's root refuses at the field", () => {
    expect(baseFindings(tree, { tree: { tree: 5 } })).toEqual([
      {
        code: "BASE_SCHEMA_MISMATCH",
        path: "base.tree",
        message: "Telo.Definition/Child: 'base.tree' does not match the parent field's schema: /tree must be object",
      },
    ]);
  });

  it("follows a reference into the parent's own $defs", () => {
    const named = {
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: { Node: { type: "object", properties: { size: { type: "integer" } } } },
    };
    expect(baseFindings(named, { node: { size: "big" } })).toEqual([
      {
        code: "BASE_SCHEMA_MISMATCH",
        path: "base.node",
        message: "Telo.Definition/Child: 'base.node' does not match the parent field's schema: /size must be integer",
      },
    ]);
  });
});
