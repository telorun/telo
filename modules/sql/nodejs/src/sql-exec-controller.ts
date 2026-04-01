import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { SqlConnectionResource } from "./sql-connection-controller.js";
import type { SqlResult } from "./sql-query-controller.js";
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
    const resolvedSql = ctx.expandValue(m.inputs.sql, input ?? {}) as string;
    const params = ctx.expandValue(m.inputs.bindings ?? [], input ?? {}) as unknown[];

    const connection = m.connection ?? m.transaction?.getConnection();
    if (!connection) {
      throw new Error("Sql: either 'connection' or 'transaction' must be set");
    }

    return runExec(connection, m.transaction, resolvedSql, params);
  }
}

async function runExec(
  connection: SqlConnectionResource,
  transaction: SqlTransactionResource | undefined,
  sql: string,
  params: unknown[],
): Promise<SqlResult> {
  const result = await connection.execute<Record<string, unknown>>(sql, params, transaction);
  return { rows: result.rows, rowCount: connection.toRowCount(result) };
}

export function register(): void {}

export async function create(
  resource: SqlExecManifest,
  ctx: ResourceContext,
): Promise<SqlExecResource> {
  return new SqlExecResource(resource, ctx);
}
