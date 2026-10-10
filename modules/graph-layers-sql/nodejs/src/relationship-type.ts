import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { GraphRelationshipType } from "@telorun/graph";
import type { DeclaredTable } from "@telorun/sql";
import {
  assertNothingUnique,
  authoredTable,
} from "./declared-references.js";
import {
  columnOf,
  refuse,
  resolveLayeredTable,
  type DeclaredTableHolder,
} from "./declared-table.js";
import { isLayeredNodeType, type LayeredNodeType } from "./node-type.js";

interface RelationshipManifest {
  kind: string;
  metadata: { name: string; module?: string };
  table?: unknown;
  source?: unknown;
  target?: unknown;
  sourceColumn?: string;
  targetColumn?: string;
}

/**
 * A relationship type over one layered table. Its endpoint columns hold
 * logical keys resolved in the layered view: no foreign key joins them to the
 * node tables, since an endpoint may be stated by any layer beneath.
 */
export class LayeredRelationshipType implements GraphRelationshipType, ResourceInstance {
  constructor(
    readonly source: LayeredNodeType,
    readonly target: LayeredNodeType,
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

export function isLayeredRelationshipType(value: unknown): value is LayeredRelationshipType {
  return value instanceof LayeredRelationshipType;
}

/** `GRAPH_ENDPOINT_TYPE_MISMATCH` — creation only: the rule would need the
 *  endpoint node's table, two references away. */
function assertEndpointType(
  describe: string,
  table: DeclaredTable,
  endpoint: "source" | "target",
  columnName: string,
  node: LayeredNodeType,
): void {
  const column = columnOf(table, columnName);
  const key = columnOf(node.declaration, node.key);
  if (!column || !key) return;
  const same =
    column.type === key.type &&
    column.array === key.array &&
    JSON.stringify(column.params) === JSON.stringify(key.params);
  if (!same) {
    refuse(
      "GRAPH_ENDPOINT_TYPE_MISMATCH",
      `${describe}: the ${endpoint} column '${columnName}' of table '${table.name}' is ` +
        `'${column.type}', but the ${endpoint} node's key '${node.key}' in table ` +
        `'${node.declaration.name}' is '${key.type}'. An endpoint column holds the node's ` +
        `key, so the two must be one type.`,
    );
  }
}

export function register(): void {}

export async function create(
  resource: RelationshipManifest,
  ctx: ResourceContext,
): Promise<LayeredRelationshipType> {
  const describe = `${resource.kind} "${resource.metadata.name}"`;
  const table = resolveLayeredTable(resource.table, ctx, describe);
  const source = ctx.resolveRef(
    resource.source,
    isLayeredNodeType,
    () => `${describe}: 'source'`,
    "GraphLayersSql.Node",
  );
  const target = ctx.resolveRef(
    resource.target,
    isLayeredNodeType,
    () => `${describe}: 'target'`,
    "GraphLayersSql.Node",
  );
  const sourceColumn = resource.sourceColumn ?? "";
  const targetColumn = resource.targetColumn ?? "";
  const authored = authoredTable(ctx, resource.metadata.name, describe);

  for (const [field, column] of [
    ["sourceColumn", sourceColumn],
    ["targetColumn", targetColumn],
  ] as const) {
    if (!authored.columns[column]) {
      refuse(
        "GRAPH_ENDPOINT_UNKNOWN_COLUMN",
        `${describe} names ${field} '${column}', which table '${authored.name}' does not ` +
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
  if (
    authored.fields.sourceColumn !== sourceColumn ||
    authored.fields.targetColumn !== targetColumn
  ) {
    refuse(
      "GRAPH_ENDPOINT_MISMATCH",
      `${describe} names endpoint columns '${sourceColumn}' and '${targetColumn}', but table ` +
        `'${authored.name}' declares '${String(authored.fields.sourceColumn)}' and ` +
        `'${String(authored.fields.targetColumn)}'. The table's uniqueness within a layer is ` +
        `built on its own endpoint columns, so the relationship type must use them.`,
    );
  }
  for (const column of [sourceColumn, targetColumn]) {
    if (authored.columns[column].nullable !== false) {
      refuse(
        "GRAPH_ENDPOINT_NULLABLE",
        `${describe}: endpoint column '${column}' of table '${authored.name}' admits NULL. ` +
          `Declare both endpoint columns 'nullable: false': a relationship always joins two ` +
          `nodes.`,
      );
    }
  }
  assertNothingUnique(describe, authored);
  assertEndpointType(describe, table.declaration, "source", sourceColumn, source);
  assertEndpointType(describe, table.declaration, "target", targetColumn, target);

  return new LayeredRelationshipType(source, target, sourceColumn, targetColumn, table);
}
