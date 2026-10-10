import { InvokeError, type ResourceContext } from "@telorun/sdk";
import type { DeclaredColumn, DeclaredTable } from "@telorun/sql";

/** The layer a row belongs to: the store's `layer` name. Internal to the table
 *  kind, so it is in no contract. */
export const LAYER_COLUMN = "graph_layer";
/** What a row says about its key in its layer. */
export const EFFECT_COLUMN = "graph_effect";

/** The row states the value. */
export const STATED = "stated";
/** The row hides whatever the layers beneath state for the key. */
export const REMOVED = "removed";
/** On a draft row only: the draft withdraws the layer's own published
 *  statement, so the layer says nothing and whatever lies beneath shows. */
export const RETRACTED = "retracted";

/** Whether a row is a draft's or published, on a table that keeps both. The
 *  two values sort draft first, which the overlay's probes rely on. */
export const STATE_COLUMN = "graph_state";
export const DRAFT = "draft";
export const PUBLISHED = "published";
/** The layer revision that published the row; null on a draft row. */
export const REVISION_COLUMN = "graph_revision";
/** On a draft row, the revision of the published row it was written over. */
export const OVER_COLUMN = "graph_over";
export const WRITTEN_AT_COLUMN = "graph_written_at";
export const RESOLUTION_COLUMN = "graph_resolution";
export const RESOLVED_BY_TYPE_COLUMN = "graph_resolved_by_type";
export const RESOLVED_BY_ID_COLUMN = "graph_resolved_by_id";

/** On a table that keeps every version of a statement: the row's own identity,
 *  which never leaves the store. */
export const ROW_COLUMN = "graph_row";
/** The changeset that wrote the row: a draft while open, a revision of its
 *  layer once published. */
export const CHANGESET_COLUMN = "graph_changeset";
/** The revision the row became current at; null while its changeset is a draft. */
export const FROM_REVISION_COLUMN = "graph_from_revision";
/** The revision the row stopped being current at; null while it is current. */
export const TO_REVISION_COLUMN = "graph_to_revision";

/** On a table that keeps every version: the `graph_row` of the winning
 *  statement among the layer's bases that the row was written over or last
 *  reconciled with; null when nothing beneath stated the identity. */
export const BENEATH_COLUMN = "graph_beneath";
/** The name a row's place in the stack is read under once a view has selected
 *  it; no column of any table. */
export const PLACE_COLUMN = "graph_place";

/** A table resource as every engine's `Table` kind exposes it. */
export interface DeclaredTableHolder {
  readonly declaration: DeclaredTable;
}

export function isDeclaredTable(value: unknown): value is DeclaredTableHolder {
  const declaration = (value as DeclaredTableHolder | undefined)?.declaration;
  return (
    !!declaration && typeof declaration.name === "string" && Array.isArray(declaration.columns)
  );
}

/** The table at a type's `table:` slot, which must carry the layer bookkeeping
 *  a strategy module's table kind declares. */
export function resolveLayeredTable(
  value: unknown,
  ctx: ResourceContext,
  describe: string,
): DeclaredTableHolder {
  const table = ctx.resolveRef(value, isDeclaredTable, () => `${describe}: 'table'`, "Sql.Table");
  for (const column of [LAYER_COLUMN, EFFECT_COLUMN]) {
    if (!table.declaration.internalColumns.includes(column)) {
      throw new Error(
        `${describe}: table '${table.declaration.name}' has no internal column '${column}', so ` +
          `it cannot hold layers. Declare it with the strategy module's own table kind.`,
      );
    }
  }
  return table;
}

/** The columns of the table's row contract — what a node or relationship type
 *  is made of. */
export function rowColumns(table: DeclaredTable): DeclaredColumn[] {
  return table.columns.filter((column) => !table.internalColumns.includes(column.name));
}

export function columnOf(table: DeclaredTable, name: string): DeclaredColumn | undefined {
  return rowColumns(table).find((column) => column.name === name);
}

/** A creation-time twin of a `telo check` rule: same code, stated first. */
export function refuse(code: string, message: string): never {
  throw new InvokeError(code, `${code}: ${message}`);
}
