import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { GraphRelationshipType } from "@telorun/graph";
import type { DeclaredTable } from "@telorun/sql";
import { columnOf, refuse, resolveTable, type DeclaredTableHolder } from "./declared-table.js";
import { isSqlNodeType, type SqlNodeType } from "./node-type.js";

interface RelationshipManifest {
  metadata: { name: string; module?: string };
  table?: unknown;
  source?: unknown;
  target?: unknown;
  sourceColumn?: string;
  targetColumn?: string;
}

/**
 * `GraphSql.Relationship` — a relationship type over one declared table whose
 * endpoint columns are cascading foreign keys to the endpoint node tables.
 */
export class SqlRelationshipType implements GraphRelationshipType, ResourceInstance {
  constructor(
    readonly source: SqlNodeType,
    readonly target: SqlNodeType,
    readonly sourceColumn: string,
    readonly targetColumn: string,
    private readonly table: DeclaredTableHolder,
  ) {}

  get declaration(): DeclaredTable {
    return this.table.declaration;
  }

  /** The table resource itself — what tells two types over one table apart. */
  get tableResource(): DeclaredTableHolder {
    return this.table;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function isSqlRelationshipType(value: unknown): value is SqlRelationshipType {
  return value instanceof SqlRelationshipType;
}

function sameColumns(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((column, index) => column === b[index]);
}

function assertCascadingKey(
  describe: string,
  table: DeclaredTable,
  endpoint: "source" | "target",
  column: string,
  node: SqlNodeType,
): void {
  const found = table.foreignKeys.some(
    (fk) =>
      sameColumns(fk.columns, [column]) &&
      fk.references.table === node.declaration.name &&
      sameColumns(fk.references.columns, [node.key]) &&
      (fk.onDelete ?? "").toLowerCase() === "cascade",
  );
  if (!found) {
    refuse(
      "GRAPH_ENDPOINT_FOREIGN_KEY_MISSING",
      `${describe}: table '${table.name}' declares no foreign key over exactly ` +
        `'${column}' (the ${endpoint} column) to '${node.declaration.name}'('${node.key}') ` +
        `with 'onDelete: cascade'. The database deletes a node's relationships through that ` +
        `key, so each endpoint needs one.`,
    );
  }
}

export function register(): void {}

export async function create(
  resource: RelationshipManifest,
  ctx: ResourceContext,
): Promise<SqlRelationshipType> {
  const describe = `GraphSql.Relationship "${resource.metadata.name}"`;
  const table = resolveTable(resource.table, ctx, describe);
  const declaration = table.declaration;
  const source = ctx.resolveRef(
    resource.source,
    isSqlNodeType,
    () => `${describe}: 'source'`,
    "GraphSql.Node",
  );
  const target = ctx.resolveRef(
    resource.target,
    isSqlNodeType,
    () => `${describe}: 'target'`,
    "GraphSql.Node",
  );
  const sourceColumn = resource.sourceColumn ?? "";
  const targetColumn = resource.targetColumn ?? "";

  for (const [field, column] of [
    ["sourceColumn", sourceColumn],
    ["targetColumn", targetColumn],
  ] as const) {
    if (!columnOf(declaration, column)) {
      refuse(
        "GRAPH_ENDPOINT_UNKNOWN_COLUMN",
        `${describe} names ${field} '${column}', which table '${declaration.name}' does not ` +
          `declare.`,
      );
    }
  }
  if (sourceColumn === targetColumn) {
    refuse(
      "GRAPH_ENDPOINT_UNKNOWN_COLUMN",
      `${describe} names '${sourceColumn}' as both sourceColumn and targetColumn.`,
    );
  }

  assertCascadingKey(describe, declaration, "source", sourceColumn, source);
  assertCascadingKey(describe, declaration, "target", targetColumn, target);

  const unique = declaration.indexes.some(
    (index) =>
      index.unique &&
      index.options.where === undefined &&
      index.columns.length === 2 &&
      index.columns.includes(sourceColumn) &&
      index.columns.includes(targetColumn),
  );
  if (!unique) {
    refuse(
      "GRAPH_RELATIONSHIP_NOT_UNIQUE",
      `${describe}: table '${declaration.name}' declares no unique index over exactly ` +
        `'${sourceColumn}' and '${targetColumn}'. At most one relationship of a type joins an ` +
        `ordered pair, and that index is what the database enforces it with.`,
    );
  }

  return new SqlRelationshipType(source, target, sourceColumn, targetColumn, table);
}
