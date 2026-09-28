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
