import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import {
  manifestListScope,
  resolveSchemaProjections,
  type ProjectionFailure,
} from "../src/schema-projection.js";
import { validateSchemaProjection } from "../src/validate-schema-projection.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * `nested`: an entry carrying a sub-collection of entries of the same shape
 * projects to the object that sub-collection projects to. Nothing here is about
 * any one domain — an extraction kind is simply the shape that needs it.
 */
const extractDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Extract", module: "extract" },
  capability: "Telo.Invocable",
  "x-telo-schema-projection": {
    entries: "/fields",
    key: "type",
    array: "many",
    nullable: "nullable",
    nested: "fields",
  },
  outputType: {
    type: "object",
    additionalProperties: false,
    required: ["fields"],
    properties: { fields: { "x-telo-schema-projection-from": "" } },
  },
  schema: {
    type: "object",
    $defs: {
      Field: {
        type: "object",
        properties: {
          selector: { type: "string" },
          type: {
            type: "string",
            enum: ["text", "number"],
            "x-telo-schema-map": { text: { type: "string" }, number: { type: "number" } },
          },
          many: { type: "boolean", default: false },
          nullable: { type: "boolean", default: false },
          fields: { type: "object", additionalProperties: { $ref: "#/$defs/Field" } },
        },
      },
    },
    properties: {
      fields: { type: "object", additionalProperties: { $ref: "#/$defs/Field" } },
    },
  },
};

const extract = {
  kind: "extract.Extract",
  metadata: { name: "page", module: "app" },
  fields: {
    title: { selector: "h1", type: "text", nullable: true },
    author: { selector: ".byline", nullable: true, fields: { name: { selector: "a", type: "text" } } },
    cards: {
      selector: ".card",
      many: true,
      fields: { name: { selector: ":scope > h2", type: "text" } },
    },
  },
};

function projectedFields(manifest: Record<string, any>) {
  const failures: ProjectionFailure[] = [];
  const scope = manifestListScope([manifest], () => extractDefinition);
  const schema = resolveSchemaProjections(
    extractDefinition.outputType,
    manifest,
    scope,
    failures,
  ) as Record<string, any>;
  return { fields: schema.properties.fields, failures };
}

describe("a nested projection", () => {
  it("projects a sub-collection to a closed object, reading omitted modifiers' defaults", () => {
    expect(projectedFields(extract)).toEqual({
      failures: [],
      fields: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { anyOf: [{ type: "string" }, { type: "null" }] },
          author: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: { name: { type: "string" } },
              },
              { type: "null" },
            ],
          },
          cards: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { name: { type: "string" } },
            },
          },
        },
      },
    });
  });

  it("stops at an entry that contains itself, and reports it", () => {
    const loop: Record<string, any> = { selector: "li" };
    loop.fields = { again: loop };
    const { failures } = projectedFields({ ...extract, fields: { loop } });
    expect(failures).toEqual([{ reason: "nested-cycle", pointer: "/fields/loop/fields/again", entry: "again" }]);
  });

  it("types a nested read through an array entry, and reports a misspelled field", () => {
    const sequence = {
      kind: "Telo.Definition",
      metadata: { name: "Sequence", module: "run" },
      capability: "Telo.Runnable",
      schema: {
        type: "object",
        properties: {
          steps: {
            "x-telo-step-context": { invoke: "invoke", outputType: "outputType" },
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                invoke: { "x-telo-ref": "Telo.Invocable" },
                inputs: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
    };
    const read = (source: string) => ({ __tagged: true, engine: "cel", source });
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "main", module: "app" },
      steps: [
        { name: "pick", invoke: { kind: "extract.Extract", name: "page" } },
        {
          name: "use",
          invoke: { kind: "extract.Extract", name: "page" },
          inputs: {
            name: read("steps.pick.result.fields.cards[0].name"),
            typo: read("steps.pick.result.fields.cards[0].nmae"),
          },
        },
      ],
    };
    const diagnostics = new StaticAnalyzer().analyze(
      withSyntheticPositions([
        extractDefinition,
        sequence,
        extract,
        seq,
      ] as unknown as ResourceManifest[]),
    );
    const reported = diagnostics
      .filter((d) => d.code === "CEL_UNKNOWN_FIELD" || d.code === "CEL_NULLABLE_ACCESS")
      .map((d) => ({ code: d.code, path: (d.data as { path?: string }).path }));
    expect(reported).toEqual([
      { code: "CEL_UNKNOWN_FIELD", path: "steps[1].inputs.typo" },
    ]);
  });
});

describe("the projection annotation", () => {
  const issuesFor = (projection: Record<string, unknown>, schema: unknown = extractDefinition.schema) =>
    validateSchemaProjection({
      ...extractDefinition,
      "x-telo-schema-projection": projection,
      schema,
    } as unknown as ResourceManifest).map(({ code, path }) => ({ code, path }));

  it("accepts a nested field whose collection is the same entry shape", () => {
    expect(issuesFor(extractDefinition["x-telo-schema-projection"])).toEqual([]);
  });

  it("is closed: an unknown key is reported", () => {
    expect(issuesFor({ ...extractDefinition["x-telo-schema-projection"], optional: "nullable" })).toEqual([
      { code: "SCHEMA_PROJECTION_INVALID", path: "x-telo-schema-projection.optional" },
    ]);
  });

  it("refuses a nested field that is not a collection of the same entries", () => {
    expect(issuesFor({ ...extractDefinition["x-telo-schema-projection"], nested: "selector" })).toEqual([
      { code: "SCHEMA_PROJECTION_INVALID", path: "x-telo-schema-projection.nested" },
    ]);
  });
});
