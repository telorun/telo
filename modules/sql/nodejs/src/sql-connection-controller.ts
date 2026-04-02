import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { randomUUID } from "crypto";
import {
  CompiledQuery,
  Kysely,
  PostgresDialect,
  SqliteDialect,
  type QueryResult,
  type Transaction,
} from "kysely";
import { Pool } from "pg";
import type { SqlTransactionResource } from "./sql-transaction-controller.js";
import type { SqliteDb } from "./sqlite-driver-interface.js";
import { currentTxId, deleteTx, getTx, setTx, txStorage } from "./transaction-store.js";

interface PoolConfig {
  min?: number;
  max?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

interface SqlConnectionManifest {
  metadata: { name: string; module: string };
  driver: "postgres" | "sqlite";
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
  file?: string;
  pool?: PoolConfig;
}

export type SqlDriver = SqlConnectionManifest["driver"];

export class SqlConnectionResource implements ResourceInstance {
  readonly driver: SqlDriver;
  private readonly db: Kysely<any>;
  private readonly sqlite?: SqliteDb;

  constructor(m: SqlConnectionManifest, sqlite?: SqliteDb) {
    this.driver = m.driver;

    if (m.driver === "postgres") {
      this.db = new Kysely({
        dialect: new PostgresDialect({
          pool: new Pool({
            ...(m.connectionString
              ? { connectionString: m.connectionString }
              : { host: m.host, port: m.port ?? 5432, database: m.database, user: m.user, password: m.password }),
            ssl: m.ssl ? { rejectUnauthorized: false } : false,
            min: m.pool?.min ?? 1,
            max: m.pool?.max ?? 10,
            idleTimeoutMillis: m.pool?.idleTimeoutMs,
            connectionTimeoutMillis: m.pool?.connectionTimeoutMs,
          }),
        }),
      });
    } else if (m.driver === "sqlite") {
      if (!sqlite) {
        throw new Error("Sql: sqlite database was not initialized");
      }
      this.sqlite = sqlite;
      this.db = new Kysely({
        dialect: new SqliteDialect({
          database: this.sqlite,
        }),
      });
    } else {
      throw new Error("Invalid SQL Connection driver");
    }
  }

  async init() {
    await this.db.connection().execute(async () => {
      // just checking
    });
  }

  async teardown(): Promise<void> {
    await this.db.destroy();
  }

  async transaction<T>(cb: () => Promise<T>): Promise<T> {
    const txId = randomUUID();

    return this.db.transaction().execute(async (trx: Transaction<any>) => {
      setTx(txId, { executor: trx });
      try {
        return await txStorage.run(txId, cb);
      } finally {
        deleteTx(txId);
      }
    });
  }

  async execute<T>(
    sql: string,
    params: unknown[] = [],
    transaction?: SqlTransactionResource,
  ): Promise<QueryResult<T>> {
    const executor = this.resolveExecutor(transaction);
    return executor.executeQuery<T>(CompiledQuery.raw(sql, params));
  }

  async executeScript(sql: string): Promise<void> {
    if (this.driver === "sqlite") {
      this.sqlite?.exec(sql);
      return;
    }

    await this.execute(sql);
  }

  toRowCount(result: QueryResult<unknown>): number {
    if (result.numAffectedRows !== undefined) {
      return Number(result.numAffectedRows);
    }

    return result.rows.length;
  }

  get kysely(): Kysely<any> {
    return this.db;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }

  private resolveExecutor(transaction?: SqlTransactionResource): Kysely<any> {
    if (transaction) {
      transaction.assertActive();
    }

    const txId = currentTxId();
    if (txId) {
      const entry = getTx(txId);
      if (entry) {
        return entry.executor as Kysely<any>;
      }
    }

    return this.db;
  }
}

export function register(): void {}

export async function create(
  resource: SqlConnectionManifest,
  ctx: ResourceContext,
): Promise<SqlConnectionResource> {
  const sqlite = resource.driver === "sqlite" ? await openSqliteDatabase(resource.file) : undefined;
  return new SqlConnectionResource(resource, sqlite);
}

async function openSqliteDatabase(file = ":memory:"): Promise<SqliteDb> {
  if (typeof Bun !== "undefined") {
    const { openDatabase } = await import("./sqlite-driver-bun.js");
    return openDatabase(file);
  }

  const { openDatabase } = await import("./sqlite-driver-node.js");
  return openDatabase(file);
}
