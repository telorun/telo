import { describe, expect, it } from "vitest";
import { scopeSlotProblems } from "../src/validate-scope-slots.js";

const scope = () => ({ type: "array", "x-telo-scope": "/steps", items: { type: "object" } });
const paths = (schema: Record<string, any>) =>
  scopeSlotProblems({ metadata: { name: "K" }, schema }).map((p) => p.path);

describe("x-telo-scope placement", () => {
  it("accepts a named top-level property, written directly, through a local $ref or in a root variant", () => {
    expect(paths({ properties: { with: scope() } })).toEqual([]);
    expect(paths({ properties: { with: { $ref: "#/$defs/With" } }, $defs: { With: scope() } })).toEqual([]);
    expect(paths({ anyOf: [{ properties: { with: scope() } }] })).toEqual([]);
  });

  it("refuses one inside a recursive shape", () => {
    expect(
      paths({
        properties: { node: { $ref: "#/$defs/Node" } },
        $defs: { Node: { properties: { with: scope(), next: { $ref: "#/$defs/Node" } } } },
      }),
    ).toEqual(["schema.$defs.Node.properties.with.x-telo-scope"]);
    expect(paths({ properties: { with: scope(), child: { $ref: "#" } } })).toEqual([
      "schema.properties.with.x-telo-scope",
    ]);
  });

  it("refuses one below an x-telo-schema-from slot, or reached by no property at all", () => {
    expect(
      paths({
        properties: { config: { "x-telo-schema-from": "backend/$defs/Options", properties: { with: scope() } } },
        $defs: { Unused: { properties: { with: scope() } } },
      }),
    ).toEqual([
      "schema.properties.config.properties.with.x-telo-scope",
      "schema.$defs.Unused.properties.with.x-telo-scope",
    ]);
  });
});
