import type { ResourceInstance } from "@telorun/sdk";
import { randomUUID } from "crypto";
import { CompiledQuery, Kysely, type QueryResult, type Transaction } from "kysely";
import type { SqlTransactionResource } from "./sql-transaction-controller.js";
import type { SqliteDb } from "./sqlite-driver-interface.js";
import { currentTxId, deleteTx, getTx, setTx, txStorage } from "./transaction-store.js";

export type SqlDriver = "postgres" | "sqlite";

/** Native bind-placeholder syntax per driver: SQLite binds anonymous `?`,
 *  PostgreSQL binds numbered `$1`, `$2`, … */
export type PlaceholderStyle = "qmark" | "numbered";

/**
 * Driver-agnostic SQL connection. The kysely instance (and, for SQLite, the
 * underlying database handle used by `executeScript`) is built by the driver
 * backend (`sql-postgres`, `sql-sqlite`) and handed in via
 * {@link createSqlConnection}. Everything here — execution, transactions,
 * placeholder style, row-count normalization — is transport-neutral.
 */
export class SqlConnectionResource implements ResourceInstance {
  private readonly db: Kysely<any>;
  private readonly sqlite?: SqliteDb;

  constructor(
    readonly driver: SqlDriver,
    db: Kysely<any>,
    sqlite?: SqliteDb,
  ) {
    this.db = db;
    this.sqlite = sqlite;
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

/**
 * Build a connection from a driver-constructed kysely instance. Driver backends
 * (`sql-postgres`, `sql-sqlite`) own dialect construction and call this; the
 * `sqlite` handle is required only for SQLite (its `executeScript` runs through
 * the native handle).
 */
export function createSqlConnection(
  driver: SqlDriver,
  db: Kysely<any>,
  sqlite?: SqliteDb,
): SqlConnectionResource {
  return new SqlConnectionResource(driver, db, sqlite);
}
