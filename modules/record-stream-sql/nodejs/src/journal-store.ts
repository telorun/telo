import { randomUUID } from "node:crypto";
import {
  type CancellationToken,
  Duration,
  InvokeError,
  type ResourceContext,
  type ResourceInstance,
  type ZoneEntry,
} from "@telorun/sdk";
import type {
  JournalPage,
  JournalScan,
  JournalStore,
  JournalStoreEntry,
} from "@telorun/record-stream";

/** The longest delay a Node timer honours; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** How often `wait` re-reads a key when `pollInterval:` is omitted. */
const DEFAULT_POLL_INTERVAL_MS = 250;

/** The slice of `Sql.Connection` this store uses, declared structurally: the
 *  module depends on no runtime package of `sql`. */
interface SqlConnection {
  readonly dialect: {
    readonly placeholderStyle: "numbered" | "qmark";
    quoteIdentifier(name: string): string;
    /** Optional here only so a backend predating it can be refused by name. */
    renderCurrentTimeMillis?(): string;
  };
  execute<T>(sql: string, params?: unknown[], zone?: ZoneEntry): Promise<SqlResult<T>>;
  executeUncommitted<T>(sql: string, params?: unknown[]): Promise<SqlResult<T>>;
  runInTransaction<T>(body: (bind: (entry: ZoneEntry) => void) => Promise<T>): Promise<T>;
  toRowCount(result: SqlResult<unknown>): number;
}

interface SqlResult<T> {
  rows: T[];
  numAffectedRows?: unknown;
}

interface StoreResource {
  metadata: { name: string; module?: string };
  connection?: unknown;
  table?: string;
  createTable?: boolean;
  pollInterval?: unknown;
}

function isSqlConnection(value: unknown): value is SqlConnection {
  const c = value as Partial<SqlConnection> | undefined;
  return (
    typeof c?.execute === "function" &&
    typeof c.executeUncommitted === "function" &&
    typeof c.runInTransaction === "function"
  );
}

/** A table name reaches SQL as an identifier, never a bind parameter: restricted
 *  to a safe character set AND double-quoted at every use. */
function validateTableName(table: string, describe: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new InvokeError(
      "ERR_INVALID_VALUE",
      `${describe}: \`table\` must be a plain identifier (letters, digits, underscore; not starting with a digit). Got "${table}".`,
    );
  }
  return table;
}

/** Drivers return a BIGINT column as a number, a bigint or a numeric string. */
function integer(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

interface HeaderRow {
  header: string;
  version: string;
  age_ms: unknown;
}

interface ReadRow extends HeaderRow {
  id: unknown;
  record: string | null;
}

/**
 * RecordStreamSql.JournalStore — the journal store over an SQL connection.
 *
 * `<table>_keys` holds one header per key (its opaque value, its version, the
 * database-clock time it was last written, the last id appended); `<table>`
 * holds the entries. Every conditional write is guarded by version equality in
 * its own `WHERE` (or by the primary key, for `putIfAbsent`), and the writes that
 * touch both tables run as one transaction, so the database settles every race
 * between processes. Ages are measured on the database clock. `wait` polls.
 */
class SqlJournalStore implements JournalStore, ResourceInstance {
  private readonly waiters = new Map<string, Set<() => void>>();
  /** Set at init, once the connection and its dialect are known. */
  private bound:
    | { connection: SqlConnection; keys: string; entries: string; ageIndex: string; now: string }
    | undefined;

  constructor(
    private readonly resource: StoreResource,
    private readonly ctx: ResourceContext,
    private readonly describe: string,
    private readonly table: string,
    private readonly pollIntervalMs: number,
  ) {}

  private use() {
    if (!this.bound) throw new Error(`${this.describe} was used before it was initialized.`);
    return this.bound;
  }

  private conn(): SqlConnection {
    return this.use().connection;
  }

  private get keys(): string {
    return this.use().keys;
  }

  private get entries(): string {
    return this.use().entries;
  }

  /** The database's clock in epoch milliseconds, as the dialect renders it. */
  private get now(): string {
    return this.use().now;
  }

  /** `$1, $2, …` on a numbered-placeholder dialect, `?` otherwise. */
  private params(count: number, from = 1): string[] {
    const numbered = this.conn().dialect.placeholderStyle === "numbered";
    const placeholders: string[] = [];
    for (let i = 0; i < count; i++) placeholders.push(numbered ? `$${from + i}` : "?");
    return placeholders;
  }

  /** A statement on the connection itself, never joining a transaction the
   *  caller has in progress: the journal is a record about work, not part of it. */
  private statement<T>(sql: string, params: unknown[]): Promise<SqlResult<T>> {
    return this.conn().executeUncommitted<T>(sql, params);
  }

  /** Run `body` as one database transaction; its statements go through `exec`. */
  private transaction<T>(
    body: (exec: <R>(sql: string, params: unknown[]) => Promise<SqlResult<R>>) => Promise<T>,
  ): Promise<T> {
    const conn = this.conn();
    const entry: ZoneEntry = { kind: this.ctx.self.ref.kind, provider: this.ctx.self };
    return conn.runInTransaction((bind) => {
      bind(entry);
      return body((sql, params) => conn.execute(sql, params, entry));
    });
  }

  private wake(key: string): void {
    const listeners = this.waiters.get(key);
    if (!listeners) return;
    this.waiters.delete(key);
    for (const listener of listeners) listener();
  }

  async init(ctx: ResourceContext): Promise<void> {
    const connection = ctx.resolveRef(
      this.resource.connection,
      isSqlConnection,
      () => `${this.describe}: 'connection'`,
      "Sql.Connection",
    );
    const { dialect } = connection;
    if (typeof dialect.renderCurrentTimeMillis !== "function") {
      throw new InvokeError(
        "ERR_INVALID_VALUE",
        `${this.describe}: the connection's SQL dialect has no 'renderCurrentTimeMillis', which this store reads the database clock through; its SQL backend predates that member and needs upgrading.`,
      );
    }
    this.bound = {
      connection,
      keys: dialect.quoteIdentifier(`${this.table}_keys`),
      entries: dialect.quoteIdentifier(this.table),
      ageIndex: dialect.quoteIdentifier(`${this.table}_keys_written_at`),
      now: dialect.renderCurrentTimeMillis(),
    };
    if (this.resource.createTable === false) return;
    await this.statement(
      `CREATE TABLE IF NOT EXISTS ${this.keys} (
         journal_key TEXT PRIMARY KEY,
         header TEXT NOT NULL,
         version TEXT NOT NULL,
         written_at BIGINT NOT NULL,
         last_id BIGINT NOT NULL
       )`,
      [],
    );
    await this.statement(
      `CREATE TABLE IF NOT EXISTS ${this.entries} (
         journal_key TEXT NOT NULL,
         id BIGINT NOT NULL,
         record TEXT NOT NULL,
         PRIMARY KEY (journal_key, id)
       )`,
      [],
    );
    // Serves `scan`: age filter and oldest-first order.
    await this.statement(
      `CREATE INDEX IF NOT EXISTS ${this.use().ageIndex} ON ${this.keys} (written_at, journal_key)`,
      [],
    );
  }

  async read(key: string, fromId: number, limit: number): Promise<JournalPage> {
    // Placeholders in textual order, so positional (`?`) binding lines up.
    const [from, to, k] = this.params(3);
    // One statement, so the header and the entries are one snapshot.
    const result = await this.statement<ReadRow>(
      `SELECT k.header AS header, k.version AS version, ${this.now} - k.written_at AS age_ms,
              e.id AS id, e.record AS record
         FROM ${this.keys} k
         LEFT JOIN ${this.entries} e
           ON e.journal_key = k.journal_key AND e.id > ${from} AND e.id <= ${to}
        WHERE k.journal_key = ${k}
        ORDER BY e.id`,
      [fromId, fromId + limit, key],
    );
    const first = result.rows[0];
    if (!first) return { header: null, entries: [] };
    const entries: JournalStoreEntry[] = [];
    for (const row of result.rows) {
      if (row.record !== null && row.id !== null) entries.push({ id: integer(row.id), record: row.record });
    }
    return {
      header: { value: first.header, version: first.version, ageMs: integer(first.age_ms) },
      entries,
    };
  }

  async putIfAbsent(key: string, value: string): Promise<string | null> {
    const version = randomUUID();
    const [k, v, ver] = this.params(3);
    const result = await this.statement(
      `INSERT INTO ${this.keys} (journal_key, header, version, written_at, last_id)
       VALUES (${k}, ${v}, ${ver}, ${this.now}, 0)
       ON CONFLICT (journal_key) DO NOTHING`,
      [key, value, version],
    );
    if (this.conn().toRowCount(result) === 0) return null;
    this.wake(key);
    return version;
  }

  async compareAndSet(key: string, version: string, value: string): Promise<string | null> {
    const next = randomUUID();
    const [v, nextVer, k, ver] = this.params(4);
    const result = await this.statement(
      `UPDATE ${this.keys} SET header = ${v}, version = ${nextVer}, written_at = ${this.now}
        WHERE journal_key = ${k} AND version = ${ver}`,
      [value, next, key, version],
    );
    if (this.conn().toRowCount(result) === 0) return null;
    this.wake(key);
    return next;
  }

  async compareAndAppend(
    key: string,
    version: string,
    record: string,
  ): Promise<{ id: number; version: string } | null> {
    const next = randomUUID();
    const appended = await this.transaction(async (exec) => {
      const [nextVer, k, ver] = this.params(3);
      const claimed = await exec(
        `UPDATE ${this.keys} SET version = ${nextVer}, last_id = last_id + 1
          WHERE journal_key = ${k} AND version = ${ver}`,
        [next, key, version],
      );
      if (this.conn().toRowCount(claimed) === 0) return null;
      const [lk] = this.params(1);
      const read = await exec<{ last_id: unknown }>(
        `SELECT last_id FROM ${this.keys} WHERE journal_key = ${lk}`,
        [key],
      );
      const id = integer(read.rows[0]?.last_id);
      const [ek, eid, rec] = this.params(3);
      await exec(`INSERT INTO ${this.entries} (journal_key, id, record) VALUES (${ek}, ${eid}, ${rec})`, [
        key,
        id,
        record,
      ]);
      return { id, version: next };
    });
    if (appended) this.wake(key);
    return appended;
  }

  async compareAndTruncate(key: string, version: string, value: string): Promise<string | null> {
    const next = randomUUID();
    const done = await this.transaction(async (exec) => {
      const [v, nextVer, k, ver] = this.params(4);
      const updated = await exec(
        `UPDATE ${this.keys} SET header = ${v}, version = ${nextVer}, written_at = ${this.now}, last_id = 0
          WHERE journal_key = ${k} AND version = ${ver}`,
        [value, next, key, version],
      );
      if (this.conn().toRowCount(updated) === 0) return false;
      const [ek] = this.params(1);
      await exec(`DELETE FROM ${this.entries} WHERE journal_key = ${ek}`, [key]);
      return true;
    });
    if (!done) return null;
    this.wake(key);
    return next;
  }

  async compareAndDelete(key: string, version: string): Promise<boolean> {
    const done = await this.transaction(async (exec) => {
      const [k, ver] = this.params(2);
      const dropped = await exec(`DELETE FROM ${this.keys} WHERE journal_key = ${k} AND version = ${ver}`, [
        key,
        version,
      ]);
      if (this.conn().toRowCount(dropped) === 0) return false;
      const [ek] = this.params(1);
      await exec(`DELETE FROM ${this.entries} WHERE journal_key = ${ek}`, [key]);
      return true;
    });
    if (done) this.wake(key);
    return done;
  }

  async scan(minAgeMs: number, cursor: string | null, limit: number): Promise<JournalScan> {
    const after = cursor === null ? null : (JSON.parse(cursor) as [number, string]);
    const values: unknown[] = [];
    const numbered = this.conn().dialect.placeholderStyle === "numbered";
    // Placeholders are minted in textual order, so positional (`?`) binding lines up.
    const bind = (value: unknown): string => {
      values.push(value);
      return numbered ? `$${values.length}` : "?";
    };
    // Oldest first; a cursor resumes after the (written_at, key) it names.
    // Compared against the column bare, so the (written_at, journal_key) index serves it.
    const age = `written_at <= ${this.now} - ${bind(minAgeMs)}`;
    const resume = after
      ? `AND (written_at > ${bind(after[0])} OR (written_at = ${bind(after[0])} AND journal_key > ${bind(after[1])}))`
      : "";
    const rows = await this.statement<HeaderRow & { journal_key: string; written_at: unknown }>(
      `SELECT journal_key, header, version, written_at, ${this.now} - written_at AS age_ms
         FROM ${this.keys}
        WHERE ${age} ${resume}
        ORDER BY written_at, journal_key
        LIMIT ${bind(limit + 1)}`,
      values,
    );
    const page = rows.rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      headers: page.map((row) => ({
        key: row.journal_key,
        value: row.header,
        version: row.version,
        ageMs: integer(row.age_ms),
      })),
      cursor: rows.rows.length > limit && last ? JSON.stringify([integer(last.written_at), last.journal_key]) : null,
    };
  }

  /**
   * Resolve once the key's version differs from `version`, or after
   * `timeoutMs`. A write through this instance wakes it at once; a write by
   * another process is seen at the next poll.
   */
  async wait(key: string, version: string | null, timeoutMs: number, cancellation: CancellationToken): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (!cancellation.isCancelled) {
      const current = await this.currentVersion(key);
      // A poll in flight when the wait was cancelled finishes; its result is discarded.
      if (cancellation.isCancelled || current !== version) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await this.pause(key, Math.min(this.pollIntervalMs, remaining), cancellation);
    }
  }

  private async currentVersion(key: string): Promise<string | null> {
    const [k] = this.params(1);
    const result = await this.statement<{ version: string }>(`SELECT version FROM ${this.keys} WHERE journal_key = ${k}`, [
      key,
    ]);
    return result.rows[0]?.version ?? null;
  }

  /** Sleep up to `ms`, returning early when this instance writes the key or the
   *  wait is cancelled. */
  private pause(key: string, ms: number, cancellation: CancellationToken): Promise<void> {
    if (cancellation.isCancelled) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let listeners = this.waiters.get(key);
      if (!listeners) {
        listeners = new Set();
        this.waiters.set(key, listeners);
      }
      const done = () => {
        clearTimeout(timer);
        unsubscribe();
        const current = this.waiters.get(key);
        if (current) {
          current.delete(done);
          if (current.size === 0) this.waiters.delete(key);
        }
        resolve();
      };
      // A pause longer than a Node timer can hold ends at its limit; the loop re-polls.
      const timer = setTimeout(done, Math.min(ms, MAX_TIMER_MS));
      listeners.add(done);
      const unsubscribe = cancellation.onCancelled(done);
    });
  }

  async provide(): Promise<SqlJournalStore> {
    return this;
  }

  snapshot(): Record<string, unknown> {
    return { pollInterval: Duration.fromMilliseconds(this.pollIntervalMs) };
  }
}

export function register(): void {}

export async function create(resource: StoreResource, ctx: ResourceContext): Promise<SqlJournalStore> {
  const describe = `RecordStreamSql.JournalStore "${resource.metadata.name}"`;
  const table = validateTableName(resource.table ?? "record_stream_journal", describe);
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  if (resource.pollInterval !== undefined) {
    if (!(resource.pollInterval instanceof Duration)) {
      throw new InvokeError("ERR_INVALID_VALUE", `${describe}: 'pollInterval' must be a duration.`);
    }
    pollIntervalMs = Number(resource.pollInterval.getMilliseconds());
  }
  if (pollIntervalMs <= 0) {
    throw new InvokeError(
      "RECORD_STREAM_SQL_POLL_INTERVAL_NOT_POSITIVE",
      `RECORD_STREAM_SQL_POLL_INTERVAL_NOT_POSITIVE: ${describe} sets 'pollInterval' to zero or less.`,
    );
  }
  return new SqlJournalStore(resource, ctx, describe, table, pollIntervalMs);
}
