import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { SqlConnectionResource } from "./sql-connection-controller.js";
import { resolveSqlConnection } from "./sql-connection-ref.js";
import { runSql } from "./sql-run.js";
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
    const connection = resolveConnection(m.connection, m.transaction, ctx);
    const result = await runSql(connection, m.transaction, input, ctx);
    return { rows: result.rows, rowCount: result.rows.length };
  }
}

function resolveConnection(
  connection: SqlConnectionResource | undefined,
  transaction: SqlTransactionResource | undefined,
  ctx: ResourceContext,
): SqlConnectionResource {
  return (
    resolveSqlConnection(connection, ctx) ?? transaction?.getConnection() ?? failMissingConnection()
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
