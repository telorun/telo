import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { SqlConnection } from "./sql-connection.js";
import { resolveSqlConnection } from "./sql-connection-ref.js";
import { runSql } from "./sql-run.js";
import type { SqlTransactionResource } from "./sql-transaction-controller.js";

interface SqlQueryManifest {
  metadata: { name: string; module: string };
  connection?: SqlConnection;
  transaction?: SqlTransactionResource;
  inputs: {
    sql: string;
    bindings?: unknown[];
  };
}

export interface SqlResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

class SqlQueryResource implements ResourceInstance {
  constructor(
    private readonly manifest: SqlQueryManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(input: unknown, invokeCtx?: InvokeContext): Promise<SqlResult> {
    const m = this.manifest;
    const ctx = this.ctx;
    const connection = resolveConnection(
      m.connection,
      m.transaction,
      ctx,
      () => `Sql.Query "${m.metadata.name}": 'connection'`,
    );
    // ERR_ZONE_REQUIRED when no sql.Transaction zone is open on THIS query's
    // connection — a transaction on another connection no longer answers.
    const zone = m.transaction ? ctx.requireZone("transaction", invokeCtx) : undefined;
    const result = await runSql(connection, zone, input, ctx, invokeCtx);
    return { rows: result.rows, rowCount: result.rows.length };
  }
}

function resolveConnection(
  connection: SqlConnection | undefined,
  transaction: SqlTransactionResource | undefined,
  ctx: ResourceContext,
  describe: () => string,
): SqlConnection {
  return (
    resolveSqlConnection(connection, ctx, describe) ??
    transaction?.getConnection() ??
    failMissingConnection()
  );
}

function failMissingConnection(): never {
  throw new Error("Sql: either 'connection' or 'transaction' must be set");
}

export function register(): void {}

export async function create(
  resource: SqlQueryManifest,
  ctx: ResourceContext,
): Promise<SqlQueryResource> {
  return new SqlQueryResource(resource, ctx);
}
