import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { SqlConnectionResource } from "./sql-connection-controller.js";
import { resolveSqlConnection } from "./sql-connection-ref.js";
import type { SqlResult } from "./sql-query-controller.js";
import { runSql } from "./sql-run.js";
import type { SqlTransactionResource } from "./sql-transaction-controller.js";

interface SqlExecManifest {
  metadata: { name: string; module: string };
  connection?: SqlConnectionResource;
  transaction?: SqlTransactionResource;
  inputs: {
    sql: string;
    bindings?: unknown[];
  };
}

class SqlExecResource implements ResourceInstance {
  constructor(
    private readonly manifest: SqlExecManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(input: unknown): Promise<SqlResult> {
    const m = this.manifest;
    const ctx = this.ctx;

    const connection = resolveSqlConnection(m.connection, ctx) ?? m.transaction?.getConnection();
    if (!connection) {
      throw new Error("Sql: either 'connection' or 'transaction' must be set");
    }

    const result = await runSql(connection, m.transaction, input, ctx);
    return { rows: result.rows, rowCount: connection.toRowCount(result) };
  }
}

export function register(): void {}

export async function create(
  resource: SqlExecManifest,
  ctx: ResourceContext,
): Promise<SqlExecResource> {
  return new SqlExecResource(resource, ctx);
}
