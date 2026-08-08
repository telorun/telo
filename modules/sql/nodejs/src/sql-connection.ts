import type { InvokeContext, ResourceInstance, ZoneEntry } from "@telorun/sdk";
import type { Kysely, QueryResult } from "kysely";

/** Native bind-placeholder syntax: SQLite binds anonymous `?`, PostgreSQL binds
 *  numbered `$1`, `$2`, … */
export type PlaceholderStyle = "qmark" | "numbered";

/**
 * Renders the SQL constructs that differ between database dialects. A backend
 * supplies one; the `Sql.*` operations build statements through it and never
 * branch on which database sits behind the connection.
 */
export interface SqlDialect {
  readonly placeholderStyle: PlaceholderStyle;

  /** Quote an identifier — table, column, alias. */
  quoteIdentifier(name: string): string;

  /** Render set membership. Dialects disagree: PostgreSQL binds the whole array
   *  to a single placeholder, SQLite binds one per element. `column` arrives
   *  already quoted. */
  renderIn(
    column: string,
    values: unknown[],
    addParam: (value: unknown) => string,
  ): string;
}

/** ANSI identifier quoting (`"name"`), for the dialects that follow the standard. */
export function quoteAnsiIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * The contract every SQL backend satisfies and every `Sql.*` operation programs
 * against. Backends (`sql-postgres`, `sql-sqlite`) own their own implementation
 * — usually by extending {@link SqlConnectionBase} — so nothing in this module
 * knows which databases exist.
 *
 * Transaction membership is ambient, carried by the kernel's execution-zone
 * stack (kernel/specs/execution-zones.md) and keyed per connection: a statement
 * executes on an open transaction's executor when a transaction zone
 * correlated on THIS connection is ambient, or when the caller passes the
 * zone entry explicitly.
 */
export interface SqlConnection extends ResourceInstance {
  readonly dialect: SqlDialect;

  /** The underlying kysely instance, when the backend is built on one —
   *  {@link SqlConnectionBase} always provides it. Optional because the contract
   *  must stay implementable by a driver kysely does not support; a consumer
   *  that needs it (`Sql.Migrations`) checks and fails with a clear message. */
  readonly kysely?: Kysely<any>;

  execute<T>(
    sql: string,
    params?: unknown[],
    zone?: ZoneEntry,
    ctx?: InvokeContext,
  ): Promise<QueryResult<T>>;

  /** Assemble SQL from literal fragments by interleaving dialect-native
   *  placeholders, then bind `values` positionally. */
  executeTemplate<T>(
    fragments: string[],
    values: unknown[],
    zone?: ZoneEntry,
    ctx?: InvokeContext,
  ): Promise<QueryResult<T>>;

  /** Run a multi-statement script. */
  executeScript(sql: string): Promise<void>;

  /** Open a database transaction and hand the caller a `bind` that keys the
   *  open executor on the zone entry the caller mints (via `ctx.withZone`).
   *  The executor stays private to this connection — the payload rule. */
  runInTransaction<T>(
    body: (bind: (entry: ZoneEntry) => void) => Promise<T>,
    ctx?: InvokeContext,
  ): Promise<T>;

  /** True when an ambient transaction zone correlated on this connection has an
   *  open executor here — the flat-nesting check `Sql.Transaction` reuses. */
  hasOpenTransaction(ctx?: InvokeContext): boolean;

  /** Rows affected by a write, normalized across drivers. */
  toRowCount(result: QueryResult<unknown>): number;
}
