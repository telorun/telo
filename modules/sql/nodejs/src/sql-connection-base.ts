import {
  InvokeError,
  type InvokeContext,
  type ResourceContext,
  type ZoneEntry,
} from "@telorun/sdk";
import { CompiledQuery, type Kysely, type QueryResult, type Transaction } from "kysely";
import type { SqlConnection, SqlDialect } from "./sql-connection.js";

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

  /** Executors for transaction zones open on THIS connection. An instance
   *  field, never a module global: the transaction controller and this base are
   *  delivered as different bundles, each inlining its own copy of a shared
   *  source file, so module scope would be one map per bundle and every lookup
   *  a miss (the payload rule, kernel/specs/execution-zones.md §8). */
  readonly #executors = new WeakMap<ZoneEntry, Kysely<any>>();

  constructor(
    db: Kysely<any>,
    readonly dialect: SqlDialect,
    protected readonly ctx: ResourceContext,
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

  async runInTransaction<T>(
    body: (bind: (entry: ZoneEntry) => void) => Promise<T>,
  ): Promise<T> {
    return this.db
      .transaction()
      .execute((trx: Transaction<any>) => body((entry) => this.#executors.set(entry, trx)));
  }

  hasOpenTransaction(ctx?: InvokeContext): boolean {
    return this.ctx.zonesFor(this, ctx).some((entry) => this.#executors.has(entry));
  }

  async execute<T>(
    sql: string,
    params: unknown[] = [],
    zone?: ZoneEntry,
    ctx?: InvokeContext,
  ): Promise<QueryResult<T>> {
    const executor = this.resolveExecutor(zone, ctx);
    return executor.executeQuery<T>(CompiledQuery.raw(sql, params));
  }

  async executeTemplate<T>(
    fragments: string[],
    values: unknown[],
    zone?: ZoneEntry,
    ctx?: InvokeContext,
  ): Promise<QueryResult<T>> {
    let sql = fragments[0] ?? "";
    for (let i = 1; i < fragments.length; i++) {
      sql += this.placeholder(i) + fragments[i];
    }
    return this.execute<T>(sql, values, zone, ctx);
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

  private resolveExecutor(zone?: ZoneEntry, ctx?: InvokeContext): Kysely<any> {
    if (zone && !this.#executors.has(zone)) {
      // A zone this connection did not open cannot be silently ignored: the
      // caller declared a requirement, and `?? this.db` here would execute it
      // outside the transaction it asked for — silent non-transactional writes
      // instead of a loud failure.
      throw new InvokeError(
        "ERR_SQL_ZONE_FOREIGN",
        `Sql: the ${zone.kind} zone provided by '${zone.provider.ref.name}' was not opened on ` +
          `this connection — the statement would execute outside the transaction it names`,
      );
    }
    const entry = zone ?? this.ctx.zonesFor(this, ctx).find((e) => this.#executors.has(e));
    return (entry && this.#executors.get(entry)) ?? this.db;
  }
}
