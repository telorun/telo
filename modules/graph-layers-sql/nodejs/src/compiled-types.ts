import {
  filterOperands,
  type GraphFilter,
  type GraphNodeValue,
  type GraphRelationshipValue,
} from "@telorun/graph";
import {
  sqlComparison,
  type SqlDialect,
  type SqlFragments,
  type SqlSchema,
} from "@telorun/sql";
import { EFFECT_COLUMN, LAYER_COLUMN, rowColumns } from "./declared-table.js";
import type { LayeredNodeType } from "./node-type.js";
import type { LayeredRelationshipType } from "./relationship-type.js";

/** A declared column, quoted once. `name` is how a row returns it and how the
 *  contract names it; `sql` is what a statement writes. */
export interface CompiledColumn {
  readonly name: string;
  readonly sql: string;
}

/**
 * Every identifier a statement over one layered table needs, derived from the
 * declaration when the store is created and never from a call's input.
 */
export interface CompiledTable {
  readonly name: string;
  /** The table as the store's schema addresses it — qualified in its namespace. */
  readonly table: string;
  /** What identifies a statement within a layer: a node's key, or a
   *  relationship's source and target. */
  readonly identity: readonly CompiledColumn[];
  /** Property columns by declared name — the only lookup an input key reaches. */
  readonly properties: ReadonlyMap<string, CompiledColumn>;
  /** `identity…, property…` — the author's columns, in one fixed order. */
  readonly columns: readonly CompiledColumn[];
  readonly layer: CompiledColumn;
  readonly effect: CompiledColumn;
  /**
   * Whether a row is a draft's or published. A column of the table where it
   * keeps one draft row beside one published row; where it keeps every version
   * ({@link versions}) the table has no such column, and this is the name a
   * view's rows are given it under when they are read.
   */
  readonly state?: CompiledColumn;
  /** Set only for a table that keeps every version of a statement. */
  readonly versions?: VersionColumns;
  /** For such a table: the name a row's place in the stack is read under once
   *  a view has selected it. No column of the table. */
  readonly place?: CompiledColumn;
}

/** What tells one version of a statement from another: its own id, the
 *  changeset that wrote it, and the revisions it was current from and to. */
export interface VersionColumns {
  readonly row: CompiledColumn;
  readonly changeset: CompiledColumn;
  readonly from: CompiledColumn;
  readonly to: CompiledColumn;
}

export interface CompiledNode extends CompiledTable {
  readonly key: CompiledColumn;
}

export interface CompiledRelationship extends CompiledTable {
  readonly sourceColumn: CompiledColumn;
  readonly targetColumn: CompiledColumn;
  readonly source: CompiledNode;
  readonly target: CompiledNode;
}

export function column(dialect: SqlDialect, name: string): CompiledColumn {
  return { name, sql: dialect.quoteIdentifier(name) };
}

function compileTable(
  dialect: SqlDialect,
  schema: SqlSchema,
  type: LayeredNodeType | LayeredRelationshipType,
  identityNames: readonly string[],
): CompiledTable {
  const declaration = type.declaration;
  const identity = identityNames.map((name) => column(dialect, name));
  const properties = new Map(
    rowColumns(declaration)
      .filter((c) => !identityNames.includes(c.name))
      .map((c) => [c.name, column(dialect, c.name)]),
  );
  return {
    name: declaration.name,
    table: schema.qualifiedTableName(declaration),
    identity,
    properties,
    columns: [...identity, ...properties.values()],
    layer: column(dialect, LAYER_COLUMN),
    effect: column(dialect, EFFECT_COLUMN),
  };
}

export function compileNode(
  dialect: SqlDialect,
  schema: SqlSchema,
  type: LayeredNodeType,
): CompiledNode {
  const table = compileTable(dialect, schema, type, [type.key]);
  return { ...table, key: table.identity[0] };
}

export function compileRelationship(
  dialect: SqlDialect,
  schema: SqlSchema,
  type: LayeredRelationshipType,
  source: CompiledNode,
  target: CompiledNode,
): CompiledRelationship {
  const table = compileTable(dialect, schema, type, [type.sourceColumn, type.targetColumn]);
  return {
    ...table,
    sourceColumn: table.identity[0],
    targetColumn: table.identity[1],
    source,
    target,
  };
}

/** `a.identity…, a.property…, a.layer` — what every read returns. `alias`
 *  empty writes the bare columns, for a `RETURNING`. */
export function selectList(table: CompiledTable, alias: string): string {
  const prefix = alias === "" ? "" : `${alias}.`;
  return [...table.columns, table.layer].map((c) => `${prefix}${c.sql}`).join(", ");
}

/** A property with no value is absent, never null. */
export function propertiesOf(
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

/** The layer a row names, as `origin` reports it. A table that stores a
 *  layer's internal id maps it back to the layer's name. */
export type OriginOf = (layer: string) => string;

const asStored: OriginOf = (layer) => layer;

export function nodeValue(
  node: CompiledNode,
  row: Record<string, unknown>,
  originOf: OriginOf = asStored,
): GraphNodeValue {
  return {
    key: row[node.key.name],
    properties: propertiesOf(row, node.properties),
    origin: originOf(String(row[node.layer.name])),
  };
}

export function relationshipValue(
  relationship: CompiledRelationship,
  row: Record<string, unknown>,
  originOf: OriginOf = asStored,
): GraphRelationshipValue {
  return {
    source: row[relationship.sourceColumn.name],
    target: row[relationship.targetColumn.name],
    properties: propertiesOf(row, relationship.properties),
    origin: originOf(String(row[relationship.layer.name])),
  };
}

export interface Assignment {
  readonly column: CompiledColumn;
  readonly value: unknown;
}

/** The declared columns an input's property map names, in its own order. An
 *  input key only ever SELECTS a declared column; it is never written itself. */
export function namedColumns(
  describe: string,
  typeName: string,
  columns: ReadonlyMap<string, CompiledColumn>,
  values: Record<string, unknown>,
): Assignment[] {
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

/** A `where` as conditions over this type's own columns, ANDed by the caller:
 *  each property a comparison names selects its declared column. */
export function filterConditions(
  describe: string,
  typeName: string,
  where: GraphFilter,
  columns: ReadonlyMap<string, CompiledColumn>,
  qualifier: string,
): SqlFragments[] {
  return filterOperands(describe, where).map(({ operator, property, value }) => {
    const [{ column }] = namedColumns(describe, typeName, columns, { [property]: value });
    return sqlComparison(`${qualifier}${column.sql}`, operator, value);
  });
}
