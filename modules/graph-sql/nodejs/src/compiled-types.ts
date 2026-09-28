import type { GraphNodeValue, GraphRelationshipValue } from "@telorun/graph";
import type { DeclaredTable, SqlDialect, SqlSchema } from "@telorun/sql";
import type { SqlNodeType } from "./node-type.js";
import type { SqlRelationshipType } from "./relationship-type.js";

/** A declared column, quoted once. `name` is how a row returns it and how the
 *  contract names it; `sql` is what a statement writes. */
export interface CompiledColumn {
  readonly name: string;
  readonly sql: string;
}

/** Every identifier a statement over one type needs, derived from the
 *  declaration when the store is created and never from a call's input. */
interface CompiledTable {
  readonly name: string;
  /** The table as the store's schema addresses it — qualified in its namespace. */
  readonly table: string;
  /** Property columns by declared name — the only lookup an input key reaches. */
  readonly properties: ReadonlyMap<string, CompiledColumn>;
  /** Property columns a row cannot be inserted without: not nullable, no
   *  default, not generated. A merge that is not given one carries the stored
   *  value into the row it proposes, since the engine checks the proposed row
   *  before it resolves the conflict. */
  readonly required: readonly CompiledColumn[];
}

export interface CompiledNode extends CompiledTable {
  readonly key: CompiledColumn;
  /** `key, property…` — the columns every statement returns. */
  readonly returning: string;
}

export interface CompiledRelationship extends CompiledTable {
  readonly sourceColumn: CompiledColumn;
  readonly targetColumn: CompiledColumn;
  readonly source: CompiledNode;
  readonly target: CompiledNode;
  /** `source, target, property…` — the columns every statement returns. */
  readonly returning: string;
}

function column(dialect: SqlDialect, name: string): CompiledColumn {
  return { name, sql: dialect.quoteIdentifier(name) };
}

function properties(
  dialect: SqlDialect,
  names: readonly string[],
  excluded: ReadonlySet<string>,
): Map<string, CompiledColumn> {
  return new Map(
    names.filter((name) => !excluded.has(name)).map((name) => [name, column(dialect, name)]),
  );
}

function requiredColumns(
  declaration: DeclaredTable,
  props: ReadonlyMap<string, CompiledColumn>,
): CompiledColumn[] {
  return declaration.columns
    .filter(
      (c) =>
        props.has(c.name) &&
        !c.nullable &&
        c.default === undefined &&
        c.defaultExpression === undefined &&
        c.identity === undefined,
    )
    .map((c) => props.get(c.name)!);
}

export function compileNode(
  dialect: SqlDialect,
  schema: SqlSchema,
  type: SqlNodeType,
): CompiledNode {
  const declaration = type.declaration;
  const key = column(dialect, type.key);
  const props = properties(
    dialect,
    declaration.columns.map((c) => c.name),
    new Set([type.key]),
  );
  return {
    name: declaration.name,
    table: schema.qualifiedTableName(declaration),
    key,
    properties: props,
    required: requiredColumns(declaration, props),
    returning: [key, ...props.values()].map((c) => c.sql).join(", "),
  };
}

export function compileRelationship(
  dialect: SqlDialect,
  schema: SqlSchema,
  type: SqlRelationshipType,
  source: CompiledNode,
  target: CompiledNode,
): CompiledRelationship {
  const declaration = type.declaration;
  const sourceColumn = column(dialect, type.sourceColumn);
  const targetColumn = column(dialect, type.targetColumn);
  const props = properties(
    dialect,
    declaration.columns.map((c) => c.name),
    new Set([type.sourceColumn, type.targetColumn]),
  );
  return {
    name: declaration.name,
    table: schema.qualifiedTableName(declaration),
    sourceColumn,
    targetColumn,
    source,
    target,
    properties: props,
    required: requiredColumns(declaration, props),
    returning: [sourceColumn, targetColumn, ...props.values()].map((c) => c.sql).join(", "),
  };
}

/** A property with no value is absent, never null. */
function propertiesOf(
  row: Record<string, unknown>,
  columns: ReadonlyMap<string, CompiledColumn>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of columns.keys()) {
    const value = row[name];
    if (value !== null && value !== undefined) out[name] = value;
  }
  return out;
}

export function nodeValue(node: CompiledNode, row: Record<string, unknown>): GraphNodeValue {
  return { key: row[node.key.name], properties: propertiesOf(row, node.properties) };
}

export function relationshipValue(
  relationship: CompiledRelationship,
  row: Record<string, unknown>,
): GraphRelationshipValue {
  return {
    source: row[relationship.sourceColumn.name],
    target: row[relationship.targetColumn.name],
    properties: propertiesOf(row, relationship.properties),
  };
}

/** The declared columns an input's property map names, in its own order. An
 *  input key only ever SELECTS a declared column; it is never written itself. */
export function namedColumns(
  describe: string,
  typeName: string,
  columns: ReadonlyMap<string, CompiledColumn>,
  values: Record<string, unknown>,
): { column: CompiledColumn; value: unknown }[] {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => {
      const found = columns.get(name);
      if (!found) {
        throw new Error(
          `${describe}: '${name}' is not a property of '${typeName}'. Its properties are: ` +
            `${[...columns.keys()].join(", ") || "(none)"}.`,
        );
      }
      return { column: found, value };
    });
}
