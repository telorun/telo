import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import {
  projectEntries,
  projectionKeyMap,
  readSchemaProjection,
} from "../src/schema-projection.js";
import { validateSchemaProjection } from "../src/validate-schema-projection.js";

/**
 * An entry that omits a modifier reads the default that applies to IT: a
 * conditional over the entry may declare it per branch, so a keying column and
 * an ordinary one project differently from the same entry schema.
 */
const keyed = {
  anyOf: [
    { required: ["key"], properties: { key: { const: true } } },
    { required: ["generated"] },
  ],
};

function tableDefinition(entryExtras: Record<string, unknown>, nullable: Record<string, unknown> = { type: "boolean" }) {
  return {
    kind: "Telo.Definition",
    metadata: { name: "Table", module: "store" },
    capability: "Telo.Provider",
    "x-telo-schema-projection": { entries: "/columns", key: "type", nullable: "nullable" },
    schema: {
      type: "object",
      properties: {
        columns: {
          type: "object",
          additionalProperties: {
            type: "object",
            ...entryExtras,
            properties: {
              type: {
                type: "string",
                enum: ["int", "text"],
                "x-telo-schema-map": { int: { type: "integer" }, text: { type: "string" } },
              },
              nullable,
              key: { type: "boolean" },
              generated: { type: "string" },
            },
          },
        },
      },
    },
  };
}

const perEntry = tableDefinition({
  allOf: [
    {
      if: keyed,
      then: { properties: { nullable: { default: false } } },
      else: { properties: { nullable: { default: true } } },
    },
  ],
});

function project(columns: Record<string, unknown>) {
  const projection = readSchemaProjection(perEntry)!;
  const map = projectionKeyMap(perEntry.schema, projection)!;
  return projectEntries({ columns }, projection, map, { kindSchema: perEntry.schema })?.properties;
}

const nullableInteger = { anyOf: [{ type: "integer" }, { type: "null" }] };

describe("a modifier default declared per entry", () => {
  it("reads the branch the entry's own fields select", () => {
    expect(
      project({
        id: { type: "int", key: true },
        serial: { type: "int", generated: "always" },
        count: { type: "int" },
        widened: { type: "int", key: true, nullable: true },
      }),
    ).toEqual({
      id: { type: "integer" },
      serial: { type: "integer" },
      count: nullableInteger,
      widened: nullableInteger,
    });
  });

  it("lands a computed condition in the branch that does not rely on it", () => {
    const computed = { __tagged: true, engine: "cel", source: "variables.isKey" };
    expect(project({ id: { type: "int", key: computed } })).toEqual({ id: nullableInteger });
  });
});

describe("a modifier default declared twice", () => {
  const issuesOf = (definition: Record<string, unknown>) =>
    validateSchemaProjection(definition as unknown as ResourceManifest).map(({ code, path }) => ({ code, path }));

  it("is refused at the kind, on the field and in a branch or in two conditionals", () => {
    expect(issuesOf(perEntry)).toEqual([]);
    const branch = {
      if: keyed,
      then: { properties: { nullable: { default: false } } },
    };
    const refused = [{ code: "SCHEMA_PROJECTION_INVALID", path: "x-telo-schema-projection.nullable" }];
    expect(issuesOf(tableDefinition({ allOf: [branch] }, { type: "boolean", default: true }))).toEqual(refused);
    expect(issuesOf(tableDefinition({ allOf: [branch, { ...branch }] }))).toEqual(refused);
  });
});
