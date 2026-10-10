import type { ResourceInstance } from "@telorun/sdk";
import type { DeclaredTable } from "./declared-schema.js";

/**
 * The contract every engine's `Schema` instance satisfies for a consumer that
 * addresses the tables it lists. The schema owns the namespace its tables live
 * in, so it is the one place a table reference is rendered: a consumer that
 * wrote a bare table name would reach whatever the session's default namespace
 * holds instead.
 */
export interface SqlSchema extends ResourceInstance {
  /** The qualified, quoted name of `table` in this schema's namespace, in the
   *  engine's own quoting. Throws when this schema does not list `table`. */
  qualifiedTableName(table: DeclaredTable): string;
}

/** True when an instance offers table addressing. An engine module older than
 *  the member does not, and a consumer must refuse it rather than address its
 *  tables unqualified. */
export function isSqlSchema(value: unknown): value is SqlSchema {
  return typeof (value as SqlSchema | undefined)?.qualifiedTableName === "function";
}

/**
 * A schema instance that also renders instants. The engine owns how an instant
 * is stored, so it is the one place "now" is written: a consumer that spelled
 * its own clock function would name an engine.
 */
export interface SqlInstantSchema extends SqlSchema {
  /**
   * The SQL expression for the instant the statement holding it runs — read
   * when that statement executes, never frozen at a transaction's start — in the
   * storage form of this engine's timestamp column. Values written through it
   * sort chronologically under a plain comparison of that column.
   */
  currentInstant(): string;
}

/** True when a schema instance renders instants. An engine module older than
 *  the member does not, and a consumer that records database time must refuse
 *  it rather than take a clock of its own. */
export function rendersCurrentInstant(value: unknown): value is SqlInstantSchema {
  return isSqlSchema(value) && typeof (value as SqlInstantSchema).currentInstant === "function";
}

/** The membership half of {@link SqlSchema.qualifiedTableName}, shared by the
 *  engines: `table` must be one `listed` declares. */
export function assertListedTable(
  describe: string,
  listed: readonly DeclaredTable[],
  table: DeclaredTable,
): void {
  if (!listed.some((declared) => declared.name === table.name)) {
    throw new Error(
      `${describe} does not list table '${table.name}' in 'tables:', so it does not address ` +
        `it. List the table there, or address it through the schema that does.`,
    );
  }
}
