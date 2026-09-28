import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { GraphNodeType } from "@telorun/graph";
import type { DeclaredTable } from "@telorun/sql";
import { columnOf, refuse, resolveTable, type DeclaredTableHolder } from "./declared-table.js";

interface NodeManifest {
  metadata: { name: string; module?: string };
  table?: unknown;
  key?: string;
}

/**
 * `GraphSql.Node` — a node type over one declared table. Holds the table's
 * declaration and performs no I/O; the store compiles its statements.
 */
export class SqlNodeType implements GraphNodeType, ResourceInstance {
  constructor(
    readonly key: string,
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
    return { key: this.key };
  }
}

export function isSqlNodeType(value: unknown): value is SqlNodeType {
  return value instanceof SqlNodeType;
}

export function register(): void {}

export async function create(resource: NodeManifest, ctx: ResourceContext): Promise<SqlNodeType> {
  const describe = `GraphSql.Node "${resource.metadata.name}"`;
  const table = resolveTable(resource.table, ctx, describe);
  const key = resource.key ?? "";
  const column = columnOf(table.declaration, key);
  if (!column) {
    refuse(
      "GRAPH_NODE_KEY_UNKNOWN_COLUMN",
      `${describe} names key column '${key}', which table '${table.declaration.name}' does ` +
        `not declare.`,
    );
  }
  const identifies = column.primaryKey || (column.unique && !column.nullable);
  if (!identifies || column.identity !== undefined) {
    refuse(
      "GRAPH_NODE_KEY_INVALID",
      `${describe} names key column '${key}', which ` +
        (column.identity !== undefined
          ? `is an identity column; a node's key is supplied by the caller, never generated.`
          : `is neither the primary key nor unique and 'nullable: false', so it does not ` +
            `identify a row.`),
    );
  }
  return new SqlNodeType(key, table);
}
