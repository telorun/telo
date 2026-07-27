import {
  decodeJsonValue,
  encodeJsonValue,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import type { KvStore, VersionedValue } from "@telorun/kv-store";
import { randomUUID } from "node:crypto";

/** The slice of `Sql.Connection` this store uses, declared structurally: the
 *  module ships a bundled controller, so it depends on no runtime package. */
interface SqlConnection {
  execute<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; numAffectedRows?: unknown }>;
  readonly placeholderStyle: "numbered" | "qmark";
}

interface StoreResource {
  metadata: { name: string; module?: string };
  connection?: unknown;
  table?: string;
  createTable?: boolean;
}

interface Row {
  value: string;
  version: string;
}

/** A table name reaches SQL as an identifier, never a bind parameter. It is
 *  restricted to a safe character set AND double-quoted at every use site —
 *  quoting matches `vector-store-pgvector`, the existing auto-DDL precedent; the
 *  whitelist is what makes injection impossible rather than merely awkward. */
function validateTableName(table: string, describe: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(
      `${describe}: \`table\` must be a plain identifier (letters, digits, underscore; ` +
        `not starting with a digit). Got "${table}".`,
    );
  }
  return table;
}

function isSqlConnection(value: unknown): value is SqlConnection {
  return typeof (value as SqlConnection | undefined)?.execute === "function";
}

/** Kysely reports affected rows as a bigint on some drivers and a number on
 *  others; both mean the same thing here. */
function affected(result: { numAffectedRows?: unknown }): number {
  const n = result.numAffectedRows;
  return typeof n === "bigint" ? Number(n) : typeof n === "number" ? n : 0;
}

/**
 * SQL-backed durable key/value store.
 *
 * Each conditional write is ONE statement whose `WHERE` carries the condition, so
 * the database resolves the race and no client-side read-then-write window
 * exists:
 *
 *  - `putIfAbsent`   — `INSERT … ON CONFLICT DO UPDATE … WHERE expires_at <= now`
 *                      (a lapsed row is logically absent, so it may be taken over)
 *  - `compareAndSet` — `UPDATE … WHERE version = ? AND expires_at > now`
 *  - `compareAndDelete` — `DELETE … WHERE version = ?`
 *
 * Expiries are epoch milliseconds supplied by the writing process rather than a
 * database `now()`, which keeps the SQL dialect-neutral at the cost of depending
 * on roughly aligned clocks. A host running far ahead can consider another
 * writer's record expired early — keep hosts on NTP and size TTLs above any
 * expected skew.
 */
class SqlKvStore implements ResourceInstance, KvStore {
  private readonly table: string;
  private readonly describe: string;
  private connection: SqlConnection | undefined;

  constructor(
    private readonly resource: StoreResource,
    private readonly ctx: ResourceContext,
  ) {
    this.describe = `KvStoreSql.Store "${resource.metadata.name}"`;
    this.table = `"${validateTableName(resource.table ?? "telo_kv_store", this.describe)}"`;
  }

  private conn(): SqlConnection {
    if (!this.connection) {
      this.connection = this.ctx.resolveRef(
        this.resource.connection,
        isSqlConnection,
        () => `${this.describe}: 'connection'`,
        "std/sql#Connection",
      );
    }
    return this.connection;
  }

  /** `$1, $2, …` on Postgres, `?` on SQLite — taken from the connection so the
   *  store stays dialect-neutral. */
  private ph(index: number): string {
    return this.conn().placeholderStyle === "numbered" ? `$${index}` : "?";
  }

  async init(): Promise<void> {
    // Opt-out for a deployment whose table is owned by the app's own migrations,
    // or whose runtime user holds no DDL grant — where an unconditional CREATE
    // fails the boot outright.
    if (this.resource.createTable === false) return;
    await this.conn().execute(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
         store_key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         version TEXT NOT NULL,
         expires_at BIGINT NOT NULL
       )`,
    );
  }

  async get(key: string): Promise<VersionedValue | null> {
    const result = await this.conn().execute<Row>(
      `SELECT value, version FROM ${this.table}
       WHERE store_key = ${this.ph(1)} AND expires_at > ${this.ph(2)}`,
      [key, Date.now()],
    );
    const row = result.rows[0];
    return row ? { value: decodeJsonValue(row.value), version: row.version } : null;
  }

  async putIfAbsent(key: string, value: unknown, ttlMs: number): Promise<VersionedValue | null> {
    const now = Date.now();
    const version = randomUUID();
    const encoded = encodeJsonValue(value);
    const result = await this.conn().execute(
      `INSERT INTO ${this.table} (store_key, value, version, expires_at)
       VALUES (${this.ph(1)}, ${this.ph(2)}, ${this.ph(3)}, ${this.ph(4)})
       ON CONFLICT (store_key) DO UPDATE
         SET value = ${this.ph(5)}, version = ${this.ph(6)}, expires_at = ${this.ph(7)}
       WHERE ${this.table}.expires_at <= ${this.ph(8)}`,
      [key, encoded, version, now + ttlMs, encoded, version, now + ttlMs, now],
    );
    return affected(result) > 0 ? { value, version } : null;
  }

  async compareAndSet(
    key: string,
    expectedVersion: string,
    value: unknown,
    ttlMs: number,
  ): Promise<VersionedValue | null> {
    const now = Date.now();
    const version = randomUUID();
    const result = await this.conn().execute(
      `UPDATE ${this.table}
         SET value = ${this.ph(1)}, version = ${this.ph(2)}, expires_at = ${this.ph(3)}
       WHERE store_key = ${this.ph(4)} AND version = ${this.ph(5)} AND expires_at > ${this.ph(6)}`,
      [encodeJsonValue(value), version, now + ttlMs, key, expectedVersion, now],
    );
    return affected(result) > 0 ? { value, version } : null;
  }

  async compareAndDelete(key: string, expectedVersion: string): Promise<boolean> {
    const result = await this.conn().execute(
      `DELETE FROM ${this.table}
       WHERE store_key = ${this.ph(1)} AND version = ${this.ph(2)}`,
      [key, expectedVersion],
    );
    return affected(result) > 0;
  }

  async provide(): Promise<SqlKvStore> {
    return this;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export const store = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: StoreResource, ctx: ResourceContext) {
    return new SqlKvStore(resource, ctx);
  },
};
