import type { ResourceContext } from "@telorun/sdk";
import type { DeclaredTable, SqlDialect, SqlSchema } from "@telorun/sql";
import {
  column,
  compileNode,
  compileRelationship,
  type CompiledColumn,
  type CompiledNode,
  type CompiledRelationship,
} from "./compiled-types.js";
import {
  isDeclaredTable,
  OVER_COLUMN,
  RESOLUTION_COLUMN,
  RESOLVED_BY_ID_COLUMN,
  RESOLVED_BY_TYPE_COLUMN,
  REVISION_COLUMN,
  STATE_COLUMN,
  WRITTEN_AT_COLUMN,
  type DeclaredTableHolder,
} from "./declared-table.js";
import type { LayeredNodeType } from "./node-type.js";
import type { LayeredRelationshipType } from "./relationship-type.js";

/** The bookkeeping a drafted table keeps on every row beside layer and effect. */
export interface DraftedColumns {
  readonly state: CompiledColumn;
  readonly revision: CompiledColumn;
  readonly over: CompiledColumn;
  readonly writtenAt: CompiledColumn;
  readonly resolution: CompiledColumn;
  readonly resolvedByType: CompiledColumn;
  readonly resolvedById: CompiledColumn;
}

export type DraftedNode = CompiledNode & DraftedColumns;
export type DraftedRelationship = Omit<CompiledRelationship, "source" | "target"> &
  DraftedColumns & { readonly source: DraftedNode; readonly target: DraftedNode };
export type DraftedTable = DraftedNode | DraftedRelationship;

const DRAFTED_COLUMNS = {
  state: STATE_COLUMN,
  revision: REVISION_COLUMN,
  over: OVER_COLUMN,
  writtenAt: WRITTEN_AT_COLUMN,
  resolution: RESOLUTION_COLUMN,
  resolvedByType: RESOLVED_BY_TYPE_COLUMN,
  resolvedById: RESOLVED_BY_ID_COLUMN,
} as const;

function draftedColumns(
  describe: string,
  dialect: SqlDialect,
  declaration: DeclaredTable,
): DraftedColumns {
  const compiled: Record<string, CompiledColumn> = {};
  for (const [member, name] of Object.entries(DRAFTED_COLUMNS)) {
    if (!declaration.internalColumns.includes(name)) {
      throw new Error(
        `${describe}: table '${declaration.name}' has no internal column '${name}', so it ` +
          `cannot hold drafts. Declare it with this strategy module's own table kind.`,
      );
    }
    compiled[member] = column(dialect, name);
  }
  return compiled as unknown as DraftedColumns;
}

export function compileDraftedNode(
  describe: string,
  dialect: SqlDialect,
  schema: SqlSchema,
  type: LayeredNodeType,
): DraftedNode {
  return {
    ...compileNode(dialect, schema, type),
    ...draftedColumns(describe, dialect, type.declaration),
  };
}

export function compileDraftedRelationship(
  describe: string,
  dialect: SqlDialect,
  schema: SqlSchema,
  type: LayeredRelationshipType,
  source: DraftedNode,
  target: DraftedNode,
): DraftedRelationship {
  return {
    ...compileRelationship(dialect, schema, type, source, target),
    ...draftedColumns(describe, dialect, type.declaration),
    source,
    target,
  };
}

/** A bookkeeping table: its address, and each column it must declare. */
export type Bookkeeping<Name extends string> = { readonly table: string } & Readonly<
  Record<Name, string>
>;

const LAYER_COLUMNS = [
  "id",
  "name",
  "head_revision",
  "created_at",
  "created_by_type",
  "created_by_id",
] as const;

export const DRAFT_COLUMNS = [
  "id",
  "public_id",
  "layer_id",
  "parent_revision",
  "message",
  "created_at",
  "created_by_type",
  "created_by_id",
  "published_at",
  "published_by_type",
  "published_by_id",
  "discarded_at",
  "discarded_by_type",
  "discarded_by_id",
  "revision",
] as const;

export type LayersTable = Bookkeeping<(typeof LAYER_COLUMNS)[number]>;
export type DraftsTable = Bookkeeping<(typeof DRAFT_COLUMNS)[number]>;

export function compileBookkeeping<Name extends string>(
  describe: string,
  field: string,
  value: unknown,
  ctx: ResourceContext,
  dialect: SqlDialect,
  schema: SqlSchema,
  names: readonly Name[],
): { compiled: Bookkeeping<Name>; resource: DeclaredTableHolder } {
  const resource = ctx.resolveRef(
    value,
    isDeclaredTable,
    () => `${describe}: '${field}'`,
    "Sql.Table",
  );
  const declared = new Set(resource.declaration.columns.map((c) => c.name));
  const compiled: Record<string, string> = {
    table: schema.qualifiedTableName(resource.declaration),
  };
  for (const name of names) {
    if (!declared.has(name)) {
      throw new Error(
        `${describe}: the table at '${field}' ('${resource.declaration.name}') has no column ` +
          `'${name}'. Declare it with this strategy module's own bookkeeping table kind.`,
      );
    }
    compiled[name] = dialect.quoteIdentifier(name);
  }
  return { compiled: compiled as Bookkeeping<Name>, resource };
}

export function compileLayersTable(
  describe: string,
  value: unknown,
  ctx: ResourceContext,
  dialect: SqlDialect,
  schema: SqlSchema,
) {
  return compileBookkeeping(describe, "layers", value, ctx, dialect, schema, LAYER_COLUMNS);
}

export function compileDraftsTable(
  describe: string,
  value: unknown,
  ctx: ResourceContext,
  dialect: SqlDialect,
  schema: SqlSchema,
) {
  return compileBookkeeping(describe, "drafts", value, ctx, dialect, schema, DRAFT_COLUMNS);
}
