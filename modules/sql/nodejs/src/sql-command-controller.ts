import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { SqlConnection } from "./sql-connection.js";
import { resolveSqlConnection } from "./sql-connection-ref.js";
import type { SqlResult } from "./sql-query-controller.js";
import { runSql } from "./sql-run.js";
import type { SqlTransactionResource } from "./sql-transaction-controller.js";

interface SqlCommandManifest {
  metadata: { name: string; module: string };
  connection?: SqlConnection;
  transaction?: SqlTransactionResource;
  inputs: {
    sql: string;
    bindings?: unknown[];
  };
}

class SqlCommandResource implements ResourceInstance {
  constructor(
    private readonly manifest: SqlCommandManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(input: unknown, invokeCtx?: InvokeContext): Promise<SqlResult> {
    const m = this.manifest;
    const ctx = this.ctx;

    const connection =
      resolveSqlConnection(m.connection, ctx, () => `Sql.Command "${m.metadata.name}": 'connection'`) ??
      m.transaction?.getConnection();
    if (!connection) {
      throw new Error("Sql: either 'connection' or 'transaction' must be set");
    }

    // ERR_ZONE_REQUIRED when no sql.Transaction zone is open on THIS statement's
    // connection — a transaction on another connection no longer answers. The
    // kernel supplies the zone kind and the correlation key (including the
    // `/transaction/connection` fallback) from the `transaction` annotation.
    const zone = m.transaction ? ctx.requireZone("transaction", invokeCtx) : undefined;
    const result = await runSql(connection, zone, input, ctx, invokeCtx);
    return { rows: result.rows, rowCount: connection.toRowCount(result) };
  }
}

export function register(): void {}

export async function create(
  resource: SqlCommandManifest,
  ctx: ResourceContext,
): Promise<SqlCommandResource> {
  return new SqlCommandResource(resource, ctx);
}
