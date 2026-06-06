import { InvokeError, isParameterizedSql, type ResourceContext } from "@telorun/sdk";
import type { QueryResult } from "kysely";
import type { SqlConnectionResource } from "./sql-connection-controller.js";
import type { SqlTransactionResource } from "./sql-transaction-controller.js";

/** Execute the `sql` input of a Query/Exec resource against `connection`.
 *
 *  Two modes:
 *  - **inline (`!sql` tag):** the expanded `sql` is a parameterized template —
 *    each `${{ }}` is bound via the connection's native placeholder, never
 *    spliced into the text.
 *  - **escape hatch (`bindings` given):** `sql` is a literal string with
 *    author-written `?` / `$n` placeholders and `bindings` bound positionally.
 *
 *  Mixing a `!sql` template with `bindings` is rejected. A plain string `sql`
 *  with neither is executed verbatim. */
export async function runSql(
  connection: SqlConnectionResource,
  transaction: SqlTransactionResource | undefined,
  input: unknown,
  ctx: ResourceContext,
): Promise<QueryResult<Record<string, unknown>>> {
  const expanded = ctx.expandValue(input, {}) as { sql: unknown; bindings?: unknown[] };
  const sql = expanded.sql;
  const bindings = expanded.bindings;
  const hasBindings = bindings !== undefined && bindings !== null;

  if (isParameterizedSql(sql)) {
    if (hasBindings) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        "Sql: a `!sql` template cannot be combined with an explicit `bindings` array. " +
          "Use one or the other — `!sql` binds each inline value automatically; " +
          "`bindings` is for hand-written ? / $n placeholders.",
      );
    }
    return connection.executeTemplate<Record<string, unknown>>(
      sql.fragments,
      sql.values,
      transaction,
    );
  }

  return connection.execute<Record<string, unknown>>(
    sql as string,
    hasBindings ? (bindings as unknown[]) : [],
    transaction,
  );
}
