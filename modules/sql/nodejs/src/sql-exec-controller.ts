import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { SqlTransactionResource } from "./sql-transaction-controller.js";
import type { SqlConnectionResource } from "./sql-connection-controller.js";
import { resolveClient } from "./sql-query-controller.js";
import type { SqlResult } from "./sql-query-controller.js";

interface SqlExecManifest {
  metadata: { name: string; module: string };
  connection?: string;
  transaction?: string;
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

    return resolveClient(ctx, m.connection, m.transaction, (client, driver) =>
      runExec(client, driver, resolvedSql, params),
    );
  }
}

async function runExec(
  client: unknown,
  driver: "postgres" | "sqlite",
  sql: string,
  params: unknown[],
): Promise<SqlResult> {
  if (driver === "postgres") {
    const pg = client as import("pg").PoolClient;
    const result = await pg.query(sql, params);
    return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
  } else {
    const db = client as import("./sqlite-driver-interface.js").SqliteDb;
    const info = db.prepare(sql).run(...params);
    return { rows: [], rowCount: info.changes };
  }
}

export function register(): void {}

export async function create(
  resource: SqlExecManifest,
  ctx: ResourceContext,
): Promise<SqlExecResource> {
  return new SqlExecResource(resource, ctx);
}
