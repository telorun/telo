import type { ResourceInstance } from "@telorun/sdk";
import { randomUUID } from "crypto";
import {
  CompiledQuery,
  Kysely,
  PostgresDialect,
  SqliteAdapter,
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

export type SqlDriver = "postgres" | "sqlite";

/** Native bind-placeholder syntax per driver: SQLite binds anonymous `?`,
 *  PostgreSQL binds numbered `$1`, `$2`, … */
export type PlaceholderStyle = "qmark" | "numbered";

export interface SqlConnectionConfig {
  driver: SqlDriver;
  /** Required for `postgres`; ignored for `sqlite` (which opens via `sqlite`). */
  connectionString?: string;
  pool?: PoolConfig;
}

export class SqlConnectionResource implements ResourceInstance {
  readonly driver: SqlDriver;
  private readonly db: Kysely<any>;
  private readonly sqlite?: SqliteDb;

  constructor(config: SqlConnectionConfig, sqlite?: SqliteDb) {
    this.driver = config.driver;

    if (this.driver === "postgres") {
      if (!config.connectionString) {
        throw new Error("Sql: postgres connection requires a connectionString");
      }
      const url = new URL(config.connectionString);
      const ssl = sslFromSslmode(url.searchParams.get("sslmode"));
      url.searchParams.delete("sslmode");
      this.db = new Kysely({
        dialect: new PostgresDialect({
          pool: new Pool({
            connectionString: url.toString(),
            ssl,
            min: config.pool?.min ?? 1,
            max: config.pool?.max ?? 10,
            idleTimeoutMillis: config.pool?.idleTimeoutMs,
            connectionTimeoutMillis: config.pool?.connectionTimeoutMs,
          }),
        }),
      });
    } else {
      if (!sqlite) {
        throw new Error("Sql: sqlite database was not initialized");
      }
      this.sqlite = sqlite;
      this.db = new Kysely({
        dialect: new TransactionalSqliteDialect({
          database: this.sqlite,
        }),
      });
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

  get placeholderStyle(): PlaceholderStyle {
    return this.driver === "postgres" ? "numbered" : "qmark";
  }

  /** Assemble SQL from literal fragments by interleaving driver-native
   *  placeholders, then bind `values` positionally. `fragments.length` must
   *  equal `values.length + 1`. */
  async executeTemplate<T>(
    fragments: string[],
    values: unknown[],
    transaction?: SqlTransactionResource,
  ): Promise<QueryResult<T>> {
    let sql = fragments[0] ?? "";
    for (let i = 1; i < fragments.length; i++) {
      sql += this.placeholder(i) + fragments[i];
    }
    return this.execute<T>(sql, values, transaction);
  }

  private placeholder(index: number): string {
    return this.placeholderStyle === "numbered" ? `$${index}` : "?";
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

// Kysely's stock SQLite adapter reports `supportsTransactionalDdl = false`, so
// its Migrator runs migrations without a transaction. SQLite does support
// transactional DDL, so we flip the flag — letting the Migrator wrap the whole
// migration batch in a single transaction, matching PostgreSQL.
class TransactionalSqliteAdapter extends SqliteAdapter {
  override get supportsTransactionalDdl(): boolean {
    return true;
  }
}

class TransactionalSqliteDialect extends SqliteDialect {
  override createAdapter(): SqliteAdapter {
    return new TransactionalSqliteAdapter();
  }
}

type SslOption =
  | false
  | { rejectUnauthorized: boolean; checkServerIdentity?: () => undefined };

function sslFromSslmode(mode: string | null): SslOption {
  switch (mode) {
    case null:
    case "disable":
      return false;
    case "require":
      return { rejectUnauthorized: false };
    case "verify-ca":
      // libpq `verify-ca` validates the CA chain but not the hostname; Node's
      // default `checkServerIdentity` enforces the hostname, so disable it.
      return { rejectUnauthorized: true, checkServerIdentity: () => undefined };
    case "verify-full":
      return { rejectUnauthorized: true };
    default:
      throw new Error(
        `Sql.Connection: unsupported sslmode '${mode}'. ` +
          `Use 'disable', 'require', 'verify-ca', or 'verify-full'.`,
      );
  }
}

export async function openSqliteDatabase(file = ":memory:"): Promise<SqliteDb> {
  // Auto-create the parent directory for file-backed databases. SQLite
  // drivers fail-fast when the directory doesn't exist; mirroring `mkdir
  // -p` here lets manifests use paths like `./tmp/foo.sqlite` without a
  // separate filesystem-prep step. `:memory:` skips filesystem entirely.
  if (file !== ":memory:") {
    const { mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const dir = dirname(file);
    if (dir && dir !== "." && dir !== "/") {
      await mkdir(dir, { recursive: true });
    }
  }

  if (typeof Bun !== "undefined") {
    const { openDatabase } = await import("./sqlite-driver-bun.js");
    return openDatabase(file);
  }

  const { openDatabase } = await import("./sqlite-driver-node.js");
  return openDatabase(file);
}
