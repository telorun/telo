import {
  SqliteDriver,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
  type SqliteDialectConfig,
} from "kysely";

/** How long a statement waits for another connection's lock before it fails. */
export const LOCK_WAIT_MS = 5000;

const FIRST_RETRY_DELAY_MS = 2;
const MAX_RETRY_DELAY_MS = 50;

export function isDatabaseBusy(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/**
 * Both drivers are synchronous, so a native busy handler blocks the whole
 * thread — and with it the other connection to the same file in this process (a
 * child application, a second connection), whose holder can then never release
 * the lock being waited on. The wait is done here instead, between statements,
 * yielding to the event loop; the drivers' own busy timeout is zero.
 */
class LockWaitingConnection implements DatabaseConnection {
  constructor(private readonly inner: DatabaseConnection) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    let delay = FIRST_RETRY_DELAY_MS;
    for (;;) {
      try {
        return await this.inner.executeQuery<R>(query);
      } catch (err) {
        if (!isDatabaseBusy(err) || Date.now() >= deadline) throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
    }
  }

  streamQuery<R>(query: CompiledQuery, chunkSize?: number): AsyncIterableIterator<QueryResult<R>> {
    return this.inner.streamQuery<R>(query, chunkSize);
  }
}

export class LockWaitingSqliteDriver extends SqliteDriver {
  constructor(config: SqliteDialectConfig) {
    super(config);
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    return new LockWaitingConnection(await super.acquireConnection());
  }
}
