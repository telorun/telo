import type { DeclaredTable, SqlDialect } from "@telorun/sql";

/**
 * The key table's layout. Every column is internal: the engine table kinds
 * declare them under `internalColumns`, so no row contract sees them, and the
 * layout changes only with this module and the engine Schema's migrations.
 */
export const COLUMN_NAMES = [
  "store_name",
  "key_id",
  "digest",
  "owner_type",
  "owner_id",
  "scopes",
  "label",
  "created_at",
  "expires_at",
  "revoked_at",
  "revoked_by",
  "last_used_at",
  "rotated_from",
  "ends_at",
] as const;

export type ColumnName = (typeof COLUMN_NAMES)[number];

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

/** The columns, each quoted in the connection's dialect. */
export type KeyColumns = Readonly<Record<ColumnName, string>>;

/**
 * The columns of a table declared with an engine module's key table kind. A
 * table declared any other way lacks them, and is refused here rather than at
 * the first statement.
 */
export function keyColumns(describe: string, table: DeclaredTable, dialect: SqlDialect): KeyColumns {
  const missing = COLUMN_NAMES.filter((column) => !table.internalColumns.includes(column));
  if (missing.length > 0) {
    throw new Error(
      `${describe}: table '${table.name}' has no internal column ${missing
        .map((column) => `'${column}'`)
        .join(", ")}, so it cannot hold API keys. Declare it with the engine ` +
        `module's own key table kind.`,
    );
  }
  return Object.fromEntries(
    COLUMN_NAMES.map((column) => [column, dialect.quoteIdentifier(column)]),
  ) as KeyColumns;
}
