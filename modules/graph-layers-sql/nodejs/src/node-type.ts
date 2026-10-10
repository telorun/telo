import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { GraphNodeType } from "@telorun/graph";
import type { DeclaredTable } from "@telorun/sql";
import {
  assertNothingUnique,
  authoredTable,
} from "./declared-references.js";
import { refuse, resolveLayeredTable, type DeclaredTableHolder } from "./declared-table.js";

interface NodeManifest {
  kind: string;
  metadata: { name: string; module?: string };
  table?: unknown;
  key?: string;
}

/**
 * A node type over one layered table. Holds the table's declaration and
 * performs no I/O; the store compiles its statements.
 */
export class LayeredNodeType implements GraphNodeType, ResourceInstance {
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

export function isLayeredNodeType(value: unknown): value is LayeredNodeType {
  return value instanceof LayeredNodeType;
}

export function register(): void {}

export async function create(
  resource: NodeManifest,
  ctx: ResourceContext,
): Promise<LayeredNodeType> {
  const describe = `${resource.kind} "${resource.metadata.name}"`;
  const table = resolveLayeredTable(resource.table, ctx, describe);
  const key = resource.key ?? "";
  const authored = authoredTable(ctx, resource.metadata.name, describe);

  const column = authored.columns[key];
  if (!column) {
    refuse(
      "GRAPH_NODE_KEY_UNKNOWN_COLUMN",
      `${describe} names key column '${key}', which table '${authored.name}' does not declare.`,
    );
  }
  if (authored.fields.key !== key) {
    refuse(
      "GRAPH_NODE_KEY_MISMATCH",
      `${describe} names key column '${key}', but table '${authored.name}' declares its key as ` +
        `'${String(authored.fields.key)}'. The table's uniqueness within a layer is built on ` +
        `its own key, so the node type must use it.`,
    );
  }
  if (
    column.nullable !== false ||
    column.primaryKey === true ||
    column.unique === true ||
    column.identity !== undefined
  ) {
    refuse(
      "GRAPH_NODE_KEY_NOT_LAYERABLE",
      `${describe} names key column '${key}', which cannot hold one statement per layer: it ` +
        `must be 'nullable: false', and must not be a primary key, unique or an identity ` +
        `column, since each layer states the same key in a row of its own.`,
    );
  }
  assertNothingUnique(describe, authored, key);
  return new LayeredNodeType(key, table);
}
