import {
  durationNanos,
  getRefIdentity,
  isCelDuration,
  type CelDuration,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
  type ZoneEntry,
} from "@telorun/sdk";
import {
  rendersInstantArithmetic,
  rendersLockSkipping,
  resolveSqlConnection,
  retentionCutoffShift,
  RowSweep,
  SqlFragments,
  SWEEP_BATCH_ROWS,
  type SqlConnection,
  type SqlInstantArithmeticSchema,
  type SqlLockSchema,
} from "@telorun/sql";
import { claimLedgerName } from "./ledger-name-claims.js";
import { isDeclaredTable, ledgerColumns, type DeclaredTableHolder, type LedgerColumns } from "./ledger-table.js";

interface LedgerManifest {
  kind: string;
  metadata: { name: string };
  connection?: unknown;
  schema?: unknown;
  table?: unknown;
  name?: unknown;
  retention?: unknown;
}

/** What recording a key found. */
export type RecordOutcome =
  /** The key was absent (or expired) and is now recorded in the caller's transaction. */
  | { readonly state: "recorded" }
  /** The key is recorded and committed, with no conflicting fingerprint. */
  | { readonly state: "duplicate" }
  /** The key is recorded under a different fingerprint. */
  | { readonly state: "conflict" };

type LedgerSchema = SqlInstantArithmeticSchema & SqlLockSchema;

/**
 * IdempotencySql.Ledger — the key record of one named ledger in one table.
 *
 * A key is written only through {@link record}, inside the zone a caller's
 * transaction opened, so it commits or rolls back with the work it guards. A key
 * older than `retention` reads as absent at write time; the background sweep
 * only reclaims the rows, in short transactions of its own that pass over rows
 * another transaction holds. `init()` performs no I/O. The sweep starts from
 * `run()` when the ledger is a boot target, and otherwise from its first
 * write, so a ledger nothing starts still reclaims its rows; either way it
 * holds nothing, so a ledger never keeps a finished application alive.
 */
export class IdempotencyLedger implements ResourceInstance {
  private readonly table: string;
  private readonly columns: LedgerColumns;
  private readonly expiry: CelDuration;
  private readonly sweep: RowSweep;

  constructor(
    readonly describe: string,
    private readonly ctx: ResourceContext,
    private readonly connection: SqlConnection,
    private readonly schema: LedgerSchema,
    private readonly tableResource: DeclaredTableHolder,
    readonly name: string,
    retention: CelDuration,
  ) {
    const declaration = tableResource.declaration;
    this.columns = ledgerColumns(describe, declaration, connection.dialect);
    this.table = schema.qualifiedTableName(declaration);
    this.expiry = retentionCutoffShift(retention, describe);
    this.sweep = new RowSweep({
      ctx,
      connection,
      retention,
      batchStatement: () => this.sweepStatement(),
      failureMessage: "Sweeping expired idempotency keys failed; the next pass tries again",
      logAttributes: { "idempotency.ledger": name },
    });
  }

  init(ctx: ResourceContext) {
    return ctx.effect("ledger name claim", async () => ({
      result: undefined,
      inverse: claimLedgerName(
        this.tableResource,
        this.tableResource.declaration.name,
        this.name,
        this,
        this.describe,
      ),
    }));
  }

  run() {
    return this.ctx.effect("expired-key sweep", async () => ({
      result: undefined,
      inverse: this.sweep.startAt(0),
    }));
  }

  snapshot(): Record<string, unknown> {
    return { name: this.name };
  }

  /**
   * Records `key` in the transaction `zone` belongs to, or reports what is
   * already recorded. A concurrent caller recording the same key waits for the
   * first transaction to end — the engine's own wait on the unique index — and
   * then finds the key (it committed) or records it (it rolled back).
   */
  async record(
    key: string,
    fingerprint: string | null,
    zone: ZoneEntry,
    ctx: InvokeContext | undefined,
  ): Promise<RecordOutcome> {
    await this.sweep.ensureStarted();
    // An expired row that no sweep has reclaimed yet is reclaimed by the write
    // itself, so a key older than retention always reads as absent. The second
    // pass covers the one interleaving where the row the first pass met is swept
    // before it is read back: the key is then absent, and recording it is right.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await this.insert(key, fingerprint, zone, ctx)) return { state: "recorded" };
      const stored = await this.storedFingerprint(key, zone, ctx);
      if (stored === undefined) continue;
      if (stored !== null && fingerprint !== null && stored !== fingerprint) {
        return { state: "conflict" };
      }
      return { state: "duplicate" };
    }
    throw new Error(
      `${this.describe}: key '${key}' was neither recorded nor found in table ` +
        `'${this.tableResource.declaration.name}' — something outside this ledger is changing ` +
        `its rows.`,
    );
  }

  private async insert(
    key: string,
    fingerprint: string | null,
    zone: ZoneEntry,
    ctx: InvokeContext | undefined,
  ): Promise<boolean> {
    const c = this.columns;
    const row = this.connection.dialect.quoteIdentifier("ledger_row");
    const statement = new SqlFragments()
      .text(
        `INSERT INTO ${this.table} AS ${row} (${c.ledgerName}, ${c.key}, ${c.fingerprint}, ` +
          `${c.recordedAt}) VALUES (`,
      )
      .value(this.name)
      .text(", ")
      .value(key)
      .text(", ")
      .value(fingerprint)
      .text(`, ${this.schema.currentInstant()}) ON CONFLICT (${c.ledgerName}, ${c.key}) DO UPDATE SET `)
      .text(`${c.fingerprint} = excluded.${c.fingerprint}, ${c.recordedAt} = excluded.${c.recordedAt}`)
      .text(` WHERE ${row}.${c.recordedAt} < `)
      .append(this.schema.currentInstantPlus(this.expiry))
      .text(` RETURNING ${c.key}`);
    const result = await this.connection.executeTemplate(
      statement.fragments,
      statement.boundValues,
      zone,
      ctx,
    );
    return result.rows.length > 0;
  }

  /** The stored digest (null for none), or undefined when no row holds the key. */
  private async storedFingerprint(
    key: string,
    zone: ZoneEntry,
    ctx: InvokeContext | undefined,
  ): Promise<string | null | undefined> {
    const c = this.columns;
    const statement = new SqlFragments()
      .text(`SELECT ${c.fingerprint} AS fingerprint FROM ${this.table} WHERE ${c.ledgerName} = `)
      .value(this.name)
      .text(` AND ${c.key} = `)
      .value(key);
    const result = await this.connection.executeTemplate<{ fingerprint: unknown }>(
      statement.fragments,
      statement.boundValues,
      zone,
      ctx,
    );
    const [found] = result.rows;
    if (!found) return undefined;
    return typeof found.fingerprint === "string" ? found.fingerprint : null;
  }

  private sweepStatement(): SqlFragments {
    const c = this.columns;
    return new SqlFragments()
      .text(`DELETE FROM ${this.table} WHERE ${c.ledgerName} = `)
      .value(this.name)
      .text(` AND ${c.key} IN (SELECT ${c.key} FROM ${this.table} WHERE ${c.ledgerName} = `)
      .value(this.name)
      .text(` AND ${c.recordedAt} < `)
      .append(this.schema.currentInstantPlus(this.expiry))
      .text(` ORDER BY ${c.recordedAt} LIMIT `)
      .value(SWEEP_BATCH_ROWS)
      .text(` ${this.schema.skipLockedClause()})`);
  }
}

export function isIdempotencyLedger(value: unknown): value is IdempotencyLedger {
  return value instanceof IdempotencyLedger;
}

export function register(): void {}

export async function create(
  resource: LedgerManifest,
  ctx: ResourceContext,
): Promise<IdempotencyLedger> {
  const describe = `${resource.kind} "${resource.metadata.name}"`;
  const connection = resolveSqlConnection(
    resource.connection as SqlConnection | undefined,
    ctx,
    () => `${describe}: 'connection'`,
  );
  if (!connection) throw new Error(`${describe}: 'connection' is required.`);
  const schema = ctx.resolveRef(
    resource.schema,
    // Any live instance, so one without the members is refused below by name.
    (candidate): candidate is object =>
      typeof candidate === "object" && candidate !== null && !!getRefIdentity(candidate),
    () => `${describe}: 'schema'`,
    "Sql.Schema",
  );
  if (!rendersInstantArithmetic(schema) || !rendersLockSkipping(schema)) {
    const identity = getRefIdentity(schema);
    throw new Error(
      `${describe}: 'schema' references '${identity?.name ?? "(inline)"}' of kind ` +
        `'${identity?.kind ?? "(unknown)"}', whose engine module predates the instant and ` +
        `lock-skipping members a ledger needs — its schema instance cannot say how the ` +
        `store's clock is read and shifted, or how a sweep passes over rows another ` +
        `transaction holds. Upgrade the module that declares that kind.`,
    );
  }
  const table = ctx.resolveRef(resource.table, isDeclaredTable, () => `${describe}: 'table'`, "Sql.Table");
  const name = resource.name;
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${describe}: 'name' must be an identifier.`);
  }
  const retention = resource.retention;
  if (!isCelDuration(retention) || durationNanos(retention) <= 0n) {
    throw new Error(`${describe}: 'retention' must be a positive duration.`);
  }
  return new IdempotencyLedger(describe, ctx, connection, schema, table, name, retention);
}
