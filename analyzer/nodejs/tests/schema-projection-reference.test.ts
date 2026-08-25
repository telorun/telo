import { describe, expect, it } from "vitest";
import {
  manifestListScope,
  projectEntries,
  projectionKeyMap,
  readSchemaProjection,
  type ProjectionFailure,
} from "../src/schema-projection.js";
import { validateSchemaProjection } from "../src/validate-schema-projection.js";

/**
 * The projection's REFERENCE path: an entry whose keyed field holds a `!ref`
 * rather than a value from the closed vocabulary.
 *
 * The map is keyed on the field's value and a reference is not a key, so such an
 * entry falls through to a path the BACKEND declares as data. Nothing here says
 * SQL, column or enum — which is the property under test as much as the shapes
 * are.
 */

/** A Postgres-shaped table kind: a named type IS its own base type. */
const pgTableDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Table", module: "postgres" },
  "x-telo-schema-projection": {
    entries: "/columns",
    key: "type",
    nullable: "nullable",
    array: "array",
    reference: { from: "values", keyword: "enum", base: { type: "string" } },
  },
  schema: {
    type: "object",
    properties: {
      columns: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            type: {
              oneOf: [
                {
                  type: "string",
                  enum: ["text", "bigint"],
                  "x-telo-schema-map": { text: { type: "string" }, bigint: { type: "integer" } },
                },
                { type: "object", "x-telo-ref": { kind: "postgres.Enum", use: "schema" } },
              ],
            },
            nullable: { type: "boolean" },
            array: { type: "boolean" },
          },
        },
      },
    },
  },
};

/** A SQLite-shaped one: no named types, so the base is a storage class the
 *  declaration names and the kind's own map resolves. */
const sqliteTableDefinition = {
  ...pgTableDefinition,
  "x-telo-schema-projection": {
    entries: "/columns",
    key: "type",
    nullable: "nullable",
    array: "array",
    reference: { from: "values", keyword: "enum", baseFrom: "baseType" },
  },
};

const pgEnum = {
  kind: "postgres.Enum",
  metadata: { name: "messageRole" },
  typeName: "message_role",
  values: ["system", "user", "assistant"],
};

const sqliteEnum = {
  kind: "postgres.Enum",
  metadata: { name: "messageRole" },
  typeName: "message_role",
  baseType: "text",
  values: ["system", "user", "assistant"],
};

const table = {
  kind: "postgres.Table",
  metadata: { name: "messages" },
  table: "messages",
  columns: {
    id: { type: "bigint" },
    role: { type: { kind: "postgres.Enum", name: "messageRole" }, nullable: false },
  },
};

function project(definition: Record<string, any>, ...manifests: Record<string, any>[]) {
  const projection = readSchemaProjection(definition)!;
  const map = projectionKeyMap(definition.schema, projection)!;
  const failures: ProjectionFailure[] = [];
  const scope = manifestListScope(manifests, () => definition);
  const projected = projectEntries(table, projection, map, {
    scope,
    pointer: "/table",
    failures,
  });
  return { projected, failures };
}

describe("the projection's reference path", () => {
  it("finds the value map on a BRANCH of the union", () => {
    const projection = readSchemaProjection(pgTableDefinition)!;
    expect(projectionKeyMap(pgTableDefinition.schema, projection)).toEqual({
      text: { type: "string" },
      bigint: { type: "integer" },
    });
  });

  it("projects a referenced declaration to its base plus the declared keyword", () => {
    const { projected, failures } = project(pgTableDefinition, pgEnum);
    expect(failures).toEqual([]);
    expect((projected as any).properties.role).toEqual({
      type: "string",
      enum: ["system", "user", "assistant"],
    });
  });

  it("reads the base from the target where the engine has no named type", () => {
    const { projected, failures } = project(sqliteTableDefinition, sqliteEnum);
    expect(failures).toEqual([]);
    // Same declaration, same projected node, two engine-native renderings —
    // which is what the split between declaration and rendering claims.
    expect((projected as any).properties.role).toEqual({
      type: "string",
      enum: ["system", "user", "assistant"],
    });
  });

  it("leaves the plain value path exactly as it was", () => {
    const { projected } = project(pgTableDefinition, pgEnum);
    expect((projected as any).properties.id).toEqual({
      anyOf: [{ type: "integer" }, { type: "null" }],
    });
  });

  it("applies the modifiers to a referenced node too", () => {
    const projection = readSchemaProjection(pgTableDefinition)!;
    const map = projectionKeyMap(pgTableDefinition.schema, projection)!;
    const arrayed = {
      ...table,
      columns: { role: { type: { kind: "postgres.Enum", name: "messageRole" }, array: true } },
    };
    const projected = projectEntries(arrayed, projection, map, {
      scope: manifestListScope([pgEnum], () => pgTableDefinition),
    });
    expect((projected as any).properties.role).toEqual({
      anyOf: [
        { type: "array", items: { type: "string", enum: ["system", "user", "assistant"] } },
        { type: "null" },
      ],
    });
  });

  // Reported AND kept: the column is declared, only its type is unknown. Dropping
  // it made the projection deny the entry exists, so a seed row naming it was told
  // the property is not allowed — blaming the row for the reference's mistake.
  it("reports an entry whose reference resolves to nothing and projects it open", () => {
    const { projected, failures } = project(pgTableDefinition);
    expect((projected as any).properties.role).toEqual({});
    expect(failures).toMatchObject([
      { reason: "entry-reference", entry: "role", name: "messageRole" },
    ]);
  });

  it("projects nothing for a reference when the backend declares no reference path", () => {
    const { ["x-telo-schema-projection"]: projection, ...rest } = pgTableDefinition;
    const noReference = {
      ...rest,
      "x-telo-schema-projection": { entries: "/columns", key: "type", nullable: "nullable" },
    };
    const { projected } = project(noReference, pgEnum);
    expect((projected as any).properties.role).toBeUndefined();
  });
});

describe("the strict half of the reference path", () => {
  const definition = (reference: unknown) =>
    ({
      kind: "Telo.Definition",
      metadata: { name: "Table", module: "postgres" },
      "x-telo-schema-projection": {
        entries: "/columns",
        key: "type",
        ...(reference === undefined ? {} : { reference }),
      },
      schema: pgTableDefinition.schema,
    }) as any;

  const messages = (reference: unknown) =>
    validateSchemaProjection(definition(reference)).map((i) => i.message);

  it("accepts the declared shape", () => {
    expect(messages({ from: "values", keyword: "enum", base: { type: "string" } })).toEqual([]);
  });

  it("refuses one missing what it has to read", () => {
    expect(messages({ base: { type: "string" } }).join(" ")).toContain("'from' and 'keyword'");
  });

  it("refuses neither base nor baseFrom — the node would have no type", () => {
    expect(messages({ from: "values", keyword: "enum" }).join(" ")).toContain(
      "declares neither 'base' nor 'baseFrom'",
    );
  });

  it("refuses both — two answers to one question", () => {
    expect(
      messages({ from: "values", keyword: "enum", base: {}, baseFrom: "baseType" }).join(" "),
    ).toContain("declare exactly one");
  });

  it("still checks map completeness now that the vocabulary sits on a branch", () => {
    const withGap = definition({ from: "values", keyword: "enum", base: { type: "string" } });
    withGap.schema = JSON.parse(JSON.stringify(pgTableDefinition.schema));
    withGap.schema.properties.columns.additionalProperties.properties.type.oneOf[0].enum.push(
      "citext",
    );
    expect(validateSchemaProjection(withGap).map((i) => i.code)).toContain("SCHEMA_MAP_INCOMPLETE");
  });
});
