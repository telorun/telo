import { randomUUID } from "crypto";
import { CompiledQuery, type Kysely, type QueryResult, type Transaction } from "kysely";
import type { SqlConnection, SqlDialect } from "./sql-connection.js";
import type { SqlTransactionResource } from "./sql-transaction-controller.js";
import { currentTxId, deleteTx, getTx, setTx, txStorage } from "./transaction-store.js";

/**
 * The dialect-neutral half of a connection: statement execution, transaction
 * scoping, template binding and row-count normalization over a kysely instance.
 *
 * Backends extend it, supply their {@link SqlDialect}, and override only what is
 * genuinely theirs — `teardown` for resources kysely does not own, `executeScript`
 * where the driver has a native multi-statement path.
 */
export abstract class SqlConnectionBase implements SqlConnection {
  protected readonly db: Kysely<any>;

  constructor(
    db: Kysely<any>,
    readonly dialect: SqlDialect,
  ) {
    this.db = db;
  }

  get kysely(): Kysely<any> {
    return this.db;
  }

  async init(): Promise<void> {
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

  /** Hand the whole script to the driver as one statement. Backends whose driver
   *  needs a dedicated multi-statement entry point override this. */
  async executeScript(sql: string): Promise<void> {
    await this.execute(sql);
  }

  toRowCount(result: QueryResult<unknown>): number {
    if (result.numAffectedRows !== undefined) {
      return Number(result.numAffectedRows);
    }

    return result.rows.length;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }

  private placeholder(index: number): string {
    return this.dialect.placeholderStyle === "numbered" ? `$${index}` : "?";
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
