import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { SqlConnectionResource } from "./sql-connection-controller.js";
import { resolveSqlConnection } from "./sql-connection-ref.js";
import type { SqlTransactionResource } from "./sql-transaction-controller.js";

interface SqlQueryManifest {
  metadata: { name: string; module: string };
  connection?: SqlConnectionResource;
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

  async invoke(input: unknown): Promise<SqlResult> {
    const m = this.manifest;
    const ctx = this.ctx;
    const resolvedSql = ctx.expandValue(m.inputs.sql, input ?? {}) as string;
    const params = ctx.expandValue(m.inputs.bindings ?? [], input ?? {}) as unknown[];

    const connection = resolveConnection(m.connection, m.transaction, ctx);
    return runQuery(connection, m.transaction, resolvedSql, params);
  }
}

function resolveConnection(
  connection: SqlConnectionResource | undefined,
  transaction: SqlTransactionResource | undefined,
  ctx: ResourceContext,
): SqlConnectionResource {
  return (
    resolveSqlConnection(connection, ctx) ??
    transaction?.getConnection() ??
    failMissingConnection()
  );
}

async function runQuery(
  connection: SqlConnectionResource,
  transaction: SqlTransactionResource | undefined,
  sql: string,
  params: unknown[],
): Promise<SqlResult> {
  const result = await connection.execute<Record<string, unknown>>(sql, params, transaction);
  return { rows: result.rows, rowCount: result.rows.length };
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
