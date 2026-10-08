import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { DiagnosticSeverity } from "../src/types.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * A bare `self.<path>` may continue past a reference slot into the declaration
 * it names: the entry receives what that declaration holds there, and `telo
 * check` checks it as the entry's own field. A rule reading a named shape reads
 * it with its `extends` parents folded in.
 */

const ref = (source: string) => ({ __tagged: true, engine: "ref", source });
const cel = (source: string) => ({ __tagged: true, engine: "cel", source });
const shapeSlot = { "x-telo-ref": { kind: "Telo.Type", use: "schema" } };

/** Holds the shapes a screen draws. */
const bundleKind = {
  kind: "Telo.Definition",
  metadata: { name: "Bundle", module: "Lib" },
  capability: "Telo.Provider",
  controllers: ["pkg:npm/fixture@1.0.0#bundle"],
  schema: {
    type: "object",
    properties: { shapes: { type: "object", properties: { list: shapeSlot, label: { type: "string" } } } },
  },
} as unknown as ResourceManifest;

/** A grid whose listed fields must be properties of its model. */
const gridKind = {
  kind: "Telo.Definition",
  metadata: { name: "Grid", module: "Lib" },
  capability: "Telo.Provider",
  controllers: ["pkg:npm/fixture@1.0.0#grid"],
  schema: {
    type: "object",
    properties: {
      model: shapeSlot,
      fields: { type: "array", items: { type: "object", properties: { property: { type: "string" } } } },
    },
    "x-telo-resource-rules": [
      {
        resolve: ["/model"],
        in: "/fields",
        condition: cel("this.property in self.model.schema.properties"),
        code: "GRID_FIELD_UNKNOWN",
        message: "lists a property the model does not declare.",
      },
    ],
  },
} as unknown as ResourceManifest;

/** A screen over a bundle: its grid is handed the bundle's list shape. */
function screenKind(gridField = "model", forwarded = "self.bundle.shapes.list"): ResourceManifest {
  return {
    kind: "Telo.Definition",
    metadata: { name: "Screen", module: "Lib" },
    capability: "Telo.Provider",
    schema: {
      type: "object",
      properties: {
        bundle: { "x-telo-ref": { kind: "Lib.Bundle", use: "dependency" } },
        fields: { type: "array", items: { type: "object", properties: { property: { type: "string" } } } },
      },
    },
    resources: [
      {
        kind: "Lib.Grid",
        metadata: { name: "grid" },
        [gridField]: cel(forwarded),
        ...(gridField === "model" ? { fields: cel("self.fields") } : {}),
      },
    ],
    provide: ref("grid"),
  } as unknown as ResourceManifest;
}

const base = {
  kind: "Telo.JsonSchema",
  metadata: { name: "Base" },
  schema: { type: "object", properties: { title: { type: "string" } } },
} as unknown as ResourceManifest;

const row = {
  kind: "Telo.JsonSchema",
  metadata: { name: "Row" },
  extends: "Base",
  schema: { type: "object", properties: { id: { type: "integer" } } },
} as unknown as ResourceManifest;

const bundle = {
  kind: "Lib.Bundle",
  metadata: { name: "bundle" },
  shapes: { list: ref("Row") },
} as unknown as ResourceManifest;

const screen = (...properties: string[]) =>
  ({
    kind: "Lib.Screen",
    metadata: { name: "screen" },
    bundle: ref("bundle"),
    fields: properties.map((property) => ({ property })),
  }) as unknown as ResourceManifest;

function errors(...manifests: ResourceManifest[]) {
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions([bundleKind, gridKind, base, row, bundle, ...manifests]))
    .filter((d) => d.severity === DiagnosticSeverity.Error);
}

describe("a forward that continues past a reference", () => {
  it("hands the entry what the referenced declaration holds, and checks it there", () => {
    const found = errors(screenKind(), screen("id", "nope"));
    expect(found.map((d) => [d.code, d.data?.resource, d.data?.path])).toEqual([
      ["RESOURCE_RULE_VIOLATED", { kind: "Lib.Screen", name: "screen" }, "fields[1]"],
    ]);
  });

  it("is clean where the entry accepts what it is handed", () => {
    expect(errors(screenKind(), screen("id"))).toEqual([]);
  });

  it("must be declared assignable to the entry's field, judged past the slot", () => {
    const library = { kind: "Telo.Library", metadata: { name: "Lib", version: "1.0.0" } } as unknown as ResourceManifest;
    const found = errors(library, screenKind("fields", "self.bundle.shapes.label"));
    expect(found.map((d) => [d.code, d.data?.resource])).toEqual([
      ["TEMPLATE_FORWARD_INCOMPATIBLE", { kind: "Telo.Definition", name: "Screen" }],
    ]);
    expect(found[0]!.message).toContain("source is 'string', target expects 'array'");
  });
});

describe("a rule reading a named shape", () => {
  const grid = (...properties: string[]) =>
    ({
      kind: "Lib.Grid",
      metadata: { name: "grid" },
      model: ref("Row"),
      fields: properties.map((property) => ({ property })),
    }) as unknown as ResourceManifest;

  it("reads the properties the shape inherits through extends", () => {
    expect(errors(grid("id", "title"))).toEqual([]);
  });

  it("still refuses a property no ancestor declares", () => {
    expect(errors(grid("title", "nope")).map((d) => [d.code, d.data?.path])).toEqual([
      ["RESOURCE_RULE_VIOLATED", "fields[1]"],
    ]);
  });
});
