import {
  InvokeError,
  SEVERITY,
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
    this.ctx.log.debug("Transaction started");
    try {
      const result = await this.db
        .transaction()
        .execute((trx: Transaction<any>) => body((entry) => this.#executors.set(entry, trx)));
      this.ctx.log.debug("Transaction committed");
      return result;
    } catch (err) {
      // The error reaches the caller, but the ROLLBACK does not: a caller that
      // maps the failure to a response sees nothing saying its writes were
      // discarded, and that is the fact worth reconstructing afterwards.
      this.ctx.log.debug("Transaction rolled back", undefined, { error: err });
      throw err;
    }
  }

  hasOpenTransaction(ctx?: InvokeContext): boolean {
    return this.ctx.zonesFor(this, ctx).some((entry) => this.#executors.has(entry));
  }

  bindsZone(zone: ZoneEntry): boolean {
    return this.#executors.has(zone);
  }

  /**
   * Every statement this connection runs funnels through here — `executeTemplate`
   * and `executeScript` both delegate — so it is the single instrumentation point.
   *
   * `db.query.text` is the statement, never the parameters: the values ARE the
   * data, and a record carrying them would put row contents in the log. The
   * statement itself is safe for a parameterized query (it is the template), and
   * is `debug`-only regardless, because `Sql.Command` can carry inline literals.
   *
   * The disabled path allocates nothing and takes no clock reading — a query is
   * the hottest thing this module does.
   */
  async execute<T>(
    sql: string,
    params: unknown[] = [],
    zone?: ZoneEntry,
    ctx?: InvokeContext,
  ): Promise<QueryResult<T>> {
    const executor = this.resolveExecutor(zone, ctx);
    return this.instrument(sql, () => executor.executeQuery<T>(CompiledQuery.raw(sql, params)));
  }

  /** The single instrumentation point, shared by every path that runs a
   *  statement. The disabled branch allocates nothing and takes no clock
   *  reading — a query is the hottest thing this module does. */
  private async instrument<T>(
    sql: string,
    run: () => Promise<QueryResult<T>>,
  ): Promise<QueryResult<T>> {
    if (!this.ctx.log.enabled(SEVERITY.debug)) return run();
    const startedAt = Date.now();
    const result = await run();
    this.ctx.log.debug("Statement executed", {
      "db.query.text": sql,
      "db.response.returned_rows": result.rows.length,
      // OTel's own name for this quantity, in OTel's own unit: SECONDS, as a
      // double. Metric names and attribute keys are separate namespaces, so
      // reusing the name is safe — what would not be safe is the name with the
      // wrong magnitude, which is why this is not milliseconds. Units live in
      // the convention, never in the key.
      "db.client.operation.duration": (Date.now() - startedAt) / 1000,
    });
    return result;
  }

  /**
   * Run a statement on the CONNECTION, never on an ambient transaction.
   *
   * The complement of {@link resolveExecutor}, and it exists because "joins
   * whatever transaction is open" is the right default and the wrong one for a
   * particular class of write: a record ABOUT the work rather than part of it.
   * A durable journal settling a run is the case that forced it — a settlement
   * discarded by the caller's rollback leaves a run recorded as still executing
   * while its effects are gone, and a claim that rolls back releases a run
   * another poller may already hold.
   *
   * On the contract rather than left to each caller to reach for `kysely`,
   * because the escape hatch is the same for everyone and a caller that reaches
   * past `execute` also loses its instrumentation — this keeps both.
   */
  async executeUncommitted<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.instrument(sql, () => this.db.executeQuery<T>(CompiledQuery.raw(sql, params)));
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
