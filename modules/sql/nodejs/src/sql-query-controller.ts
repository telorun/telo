import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { SqlConnectionResource } from "./sql-connection-controller.js";
import type { SqlTransactionResource } from "./sql-transaction-controller.js";
import { currentTxId, getTx } from "./transaction-store.js";

interface SqlQueryManifest {
  metadata: { name: string; module: string };
  connection?: string;
  transaction?: string;
  sql: string;
  inputs?: Record<string, unknown>;
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
    const resolvedSql = ctx.expandValue(m.sql, input ?? {}) as string;
    const resolvedInputs = ctx.expandValue(m.inputs ?? {}, input ?? {}) as Record<string, unknown>;
    const params = Object.values(resolvedInputs);

    return resolveClient(ctx, m.connection, m.transaction, (client, driver) =>
      runQuery(client, driver, resolvedSql, params),
    );
  }
}

export async function resolveClient<T>(
  ctx: ResourceContext,
  connectionName: string | undefined,
  transactionName: string | undefined,
  fn: (client: unknown, driver: "postgres" | "sqlite") => Promise<T>,
): Promise<T> {
  if (transactionName) {
    const txResource = ctx.moduleContext.getInstance(transactionName) as SqlTransactionResource;
    const { client, driver } = txResource.getClient();
    return fn(client, driver);
  }

  if (!connectionName) {
    throw new Error("Sql: either 'connection' or 'transaction' must be set");
  }

  const conn = ctx.moduleContext.getInstance(connectionName) as SqlConnectionResource;

  if (conn.driver === "sqlite") {
    return fn(conn.getDb(), "sqlite");
  }

  const txId = currentTxId();
  if (txId) {
    const entry = getTx(txId);
    if (entry) return fn(entry.client, entry.driver);
  }

  const pgClient = await conn.getPool().connect();
  try {
    return await fn(pgClient, "postgres");
  } finally {
    pgClient.release();
  }
}

async function runQuery(
  client: unknown,
  driver: "postgres" | "sqlite",
  sql: string,
  params: unknown[],
): Promise<SqlResult> {
  if (driver === "postgres") {
    const pg = client as import("pg").PoolClient;
    const result = await pg.query(sql, params);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  } else {
    const db = client as import("./sqlite-driver-interface.js").SqliteDb;
    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    return { rows, rowCount: rows.length };
  }
}

export function register(): void {}

export async function create(
  resource: SqlQueryManifest,
  ctx: ResourceContext,
): Promise<SqlQueryResource> {
  return new SqlQueryResource(resource, ctx);
}
