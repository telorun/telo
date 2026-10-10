import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// A strategy table kind maps onto the engine `Table` with `base:`, so it has a
// schema of its own: the engine's column, index and check vocabulary and its
// row projection are restated in it, and it inherits none of the engine
// table's rules. This holds the restatement to the engine — a storage class, an
// index option or a rule added there turns this red until it is carried here.

type Json = Record<string, any>;

const manifest = (relative: string): Json[] =>
  parseAllDocuments(readFileSync(new URL(relative, import.meta.url), "utf8"), {
    logLevel: "silent",
  }).map((doc) => doc.toJS());

const kind = (docs: Json[], name: string): Json => {
  const found = docs.find((doc) => doc.metadata?.name === name && doc.schema);
  if (!found) throw new Error(`no kind '${name}' is declared`);
  return found;
};

const own = manifest("../../telo.yaml");
const engineTable = kind(manifest("../../../postgres/telo.yaml"), "Table");
const sqlTable = kind(manifest("../../../sql/telo.yaml"), "Table");

/** Every intended difference from the engine's entry, by path: what the engine
 *  writes there and what this module writes instead. */
const DIFFERENCES: { path: string[]; engine: unknown; own: unknown; why: string }[] = [
  {
    path: ["columns", "properties", "type", "oneOf", "1", "x-telo-ref", "kind"],
    engine: "Self.Enum",
    own: "Postgres.Enum",
    why: "the engine names its own enum kind; from here it is reached through the import alias",
  },
];

/** Engine table rules no strategy table kind restates, each with the reason its
 *  author surface cannot violate it. */
const EXCLUDED_RULES: Record<string, string> = {
  SQL_COLUMN_DECLARED_TWICE: "no `internalColumns` field; a `graph_` name is refused by the schema",
  SQL_FOREIGN_KEY_UNKNOWN_COLUMN: "no `foreignKeys` field",
  SQL_FOREIGN_KEY_ARITY_MISMATCH: "no `foreignKeys` field",
  SQL_INTERNAL_COLUMN_RENAME_FROM_SELF: "no `internalColumns` field",
  SQL_INTERNAL_COLUMN_RENAME_SOURCE_STILL_DECLARED: "no `internalColumns` field",
  SQL_SEED_KEY_UNKNOWN_COLUMN: "no `seeds` field",
  SQL_SEED_ROW_MISSING_KEY: "no `seeds` field",
};

const entry = (table: Json, field: string): Json => table.schema.properties[field].additionalProperties;

function at(value: any, path: string[]): { holder: any; key: string } {
  const holder = path.slice(0, -1).reduce((node, step) => node?.[step], value);
  return { holder, key: path[path.length - 1] };
}

/** This module's entries with each named difference checked and put back to
 *  the engine's spelling, so what remains must be equal. */
function reconciled(table: Json): Json {
  const entries: Json = structuredClone({
    columns: entry(table, "columns"),
    indexes: entry(table, "indexes"),
    checks: entry(table, "checks"),
  });
  for (const difference of DIFFERENCES) {
    const { holder, key } = at(entries, difference.path);
    expect(holder?.[key], `${difference.path.join(".")} — ${difference.why}`).toEqual(difference.own);
    holder[key] = difference.engine;
  }
  return entries;
}

const ruleCodes = (schema: Json): string[] =>
  [...(schema["x-telo-resource-rules"] ?? []), ...(schema["x-telo-referrer-rules"] ?? [])].map(
    (rule: Json) => rule.code,
  );

describe.each(["NodeTable", "RelationshipTable"])("%s", (name) => {
  const table = kind(own, name);

  it("declares columns, indexes and checks in the engine table's own vocabulary", () => {
    expect(reconciled(table)).toEqual({
      columns: entry(engineTable, "columns"),
      indexes: entry(engineTable, "indexes"),
      checks: entry(engineTable, "checks"),
    });
  });

  it("projects its rows as the engine table does", () => {
    expect(table["x-telo-schema-projection"]).toEqual(engineTable["x-telo-schema-projection"]);
  });

  it("restates every engine table rule its author surface can violate", () => {
    const restated = new Set(ruleCodes(table.schema));
    const owed = [...ruleCodes(sqlTable.schema), ...ruleCodes(engineTable.schema)];
    expect(owed.length).toBeGreaterThan(0);
    expect(owed.filter((code) => !restated.has(code) && !(code in EXCLUDED_RULES))).toEqual([]);
  });
});
