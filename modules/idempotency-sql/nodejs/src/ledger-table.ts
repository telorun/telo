import type { DeclaredTable, SqlDialect } from "@telorun/sql";

/**
 * The ledger table's layout. Every column is internal: the engine table kinds
 * declare them under `internalColumns`, so no row contract sees them, and the
 * layout changes only with this module and the engine Schema's migrations.
 */
export const LEDGER_NAME_COLUMN = "ledger_name";
export const KEY_COLUMN = "idempotency_key";
export const FINGERPRINT_COLUMN = "fingerprint";
export const RECORDED_AT_COLUMN = "recorded_at";

const LEDGER_COLUMNS = [LEDGER_NAME_COLUMN, KEY_COLUMN, FINGERPRINT_COLUMN, RECORDED_AT_COLUMN];

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

/** The ledger's columns, each quoted in the connection's dialect. */
export interface LedgerColumns {
  readonly ledgerName: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly recordedAt: string;
}

/**
 * The columns of a table declared with an engine module's ledger table kind.
 * A table declared any other way lacks them, and is refused here rather than at
 * the first statement.
 */
export function ledgerColumns(
  describe: string,
  table: DeclaredTable,
  dialect: SqlDialect,
): LedgerColumns {
  const missing = LEDGER_COLUMNS.filter((column) => !table.internalColumns.includes(column));
  if (missing.length > 0) {
    throw new Error(
      `${describe}: table '${table.name}' has no internal column ${missing
        .map((column) => `'${column}'`)
        .join(", ")}, so it cannot hold idempotency keys. Declare it with the engine ` +
        `module's own ledger table kind.`,
    );
  }
  return {
    ledgerName: dialect.quoteIdentifier(LEDGER_NAME_COLUMN),
    key: dialect.quoteIdentifier(KEY_COLUMN),
    fingerprint: dialect.quoteIdentifier(FINGERPRINT_COLUMN),
    recordedAt: dialect.quoteIdentifier(RECORDED_AT_COLUMN),
  };
}
