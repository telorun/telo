import type { ResourceContext } from "@telorun/sdk";
import type { DeclaredTable, SqlDialect, SqlSchema } from "@telorun/sql";
import {
  column,
  compileNode,
  compileRelationship,
  type CompiledColumn,
  type CompiledNode,
  type CompiledRelationship,
  type VersionColumns,
} from "./compiled-types.js";
import {
  BENEATH_COLUMN,
  CHANGESET_COLUMN,
  FROM_REVISION_COLUMN,
  OVER_COLUMN,
  PLACE_COLUMN,
  RESOLUTION_COLUMN,
  RESOLVED_BY_ID_COLUMN,
  RESOLVED_BY_TYPE_COLUMN,
  ROW_COLUMN,
  STATE_COLUMN,
  TO_REVISION_COLUMN,
} from "./declared-table.js";
import { compileBookkeeping, DRAFT_COLUMNS, type Bookkeeping } from "./drafted-tables.js";
import type { LayeredNodeType } from "./node-type.js";
import type { LayeredRelationshipType } from "./relationship-type.js";

/**
 * The bookkeeping a revisioned table keeps on every row beside layer and
 * effect. A row is one version of one layer's statement about one identity,
 * written by exactly one changeset. `state` is no column of the table: it is
 * the name a row's state is read under once a view has selected the row.
 */
export interface RevisionedColumns {
  readonly row: CompiledColumn;
  readonly versions: VersionColumns;
  readonly state: CompiledColumn;
  readonly place: CompiledColumn;
  readonly over: CompiledColumn;
  /** The row among the layer's bases this row was written over. */
  readonly beneath: CompiledColumn;
  readonly resolution: CompiledColumn;
  readonly resolvedByType: CompiledColumn;
  readonly resolvedById: CompiledColumn;
}

export type RevisionedNode = CompiledNode & RevisionedColumns;
export type RevisionedRelationship = Omit<CompiledRelationship, "source" | "target"> &
  RevisionedColumns & { readonly source: RevisionedNode; readonly target: RevisionedNode };
export type RevisionedTable = RevisionedNode | RevisionedRelationship;

const STORED = [
  ROW_COLUMN,
  CHANGESET_COLUMN,
  FROM_REVISION_COLUMN,
  TO_REVISION_COLUMN,
  OVER_COLUMN,
  BENEATH_COLUMN,
  RESOLUTION_COLUMN,
  RESOLVED_BY_TYPE_COLUMN,
  RESOLVED_BY_ID_COLUMN,
] as const;

function revisionedColumns(
  describe: string,
  dialect: SqlDialect,
  declaration: DeclaredTable,
): RevisionedColumns {
  for (const name of STORED) {
    if (!declaration.internalColumns.includes(name)) {
      throw new Error(
        `${describe}: table '${declaration.name}' has no internal column '${name}', so it ` +
          `cannot hold revisions. Declare it with this strategy module's own table kind.`,
      );
    }
  }
  return {
    row: column(dialect, ROW_COLUMN),
    versions: {
      row: column(dialect, ROW_COLUMN),
      changeset: column(dialect, CHANGESET_COLUMN),
      from: column(dialect, FROM_REVISION_COLUMN),
      to: column(dialect, TO_REVISION_COLUMN),
    },
    state: column(dialect, STATE_COLUMN),
    place: column(dialect, PLACE_COLUMN),
    over: column(dialect, OVER_COLUMN),
    beneath: column(dialect, BENEATH_COLUMN),
    resolution: column(dialect, RESOLUTION_COLUMN),
    resolvedByType: column(dialect, RESOLVED_BY_TYPE_COLUMN),
    resolvedById: column(dialect, RESOLVED_BY_ID_COLUMN),
  };
}

export function compileRevisionedNode(
  describe: string,
  dialect: SqlDialect,
  schema: SqlSchema,
  type: LayeredNodeType,
): RevisionedNode {
  return {
    ...compileNode(dialect, schema, type),
    ...revisionedColumns(describe, dialect, type.declaration),
  };
}

export function compileRevisionedRelationship(
  describe: string,
  dialect: SqlDialect,
  schema: SqlSchema,
  type: LayeredRelationshipType,
  source: RevisionedNode,
  target: RevisionedNode,
): RevisionedRelationship {
  return {
    ...compileRelationship(dialect, schema, type, source, target),
    ...revisionedColumns(describe, dialect, type.declaration),
    source,
    target,
  };
}

const CHANGESET_COLUMNS = [
  ...DRAFT_COLUMNS,
  "label",
  "labelled_at",
  "labelled_by_type",
  "labelled_by_id",
  "bases_changeset",
] as const;

/**
 * One row per changeset: a draft while open, a revision of its layer once
 * published. Beside what a drafts table holds: the revision's label with who
 * gave it and when, and `bases_changeset` — the changeset whose rows in the
 * bases table are this changeset's base list, null for a layer built on none.
 */
export type ChangesetsTable = Bookkeeping<(typeof CHANGESET_COLUMNS)[number]>;

export function compileChangesetsTable(
  describe: string,
  value: unknown,
  ctx: ResourceContext,
  dialect: SqlDialect,
  schema: SqlSchema,
) {
  return compileBookkeeping(describe, "changesets", value, ctx, dialect, schema, CHANGESET_COLUMNS);
}

const CHANGESET_BASE_COLUMNS = [
  "id",
  "changeset_id",
  "position",
  "base_layer_id",
  "base_revision",
] as const;

/** A base list, stored once per change: one row per direct pin, under the
 *  changeset that made the change. */
export type ChangesetBasesTable = Bookkeeping<(typeof CHANGESET_BASE_COLUMNS)[number]>;

export function compileChangesetBasesTable(
  describe: string,
  value: unknown,
  ctx: ResourceContext,
  dialect: SqlDialect,
  schema: SqlSchema,
) {
  return compileBookkeeping(
    describe,
    "changesetBases",
    value,
    ctx,
    dialect,
    schema,
    CHANGESET_BASE_COLUMNS,
  );
}
