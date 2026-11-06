import { createRequire } from "node:module";
import type { ResourceContext } from "@telorun/sdk";

interface Database {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown };
}

/** A connection slice over an in-memory `node:sqlite` database, with the transaction semantics the store relies on. */
export function sqliteConnection() {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string) => Database;
  };
  const db = new DatabaseSync(":memory:");
  const run = async (sql: string, params: unknown[] = []) => {
    const statement = db.prepare(sql);
    if (/^\s*(SELECT|WITH)/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
      return { rows: statement.all(...params) as never[] };
    }
    statement.run(...params);
    return { rows: [] as never[] };
  };
  const connection = {
    dialect: {
      placeholderStyle: "qmark" as const,
      quoteIdentifier: (name: string) => `"${name}"`,
    },
    execute: run,
    async runInTransaction<T>(body: (bind: () => void) => Promise<T>): Promise<T> {
      db.exec("BEGIN");
      try {
        const result = await body(() => undefined);
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
  return { connection, db };
}

export const context = {
  resolveRef: (value: unknown) => value,
  self: { id: "store", ref: { kind: "AiConversationSql.Store", name: "store" } },
} as unknown as ResourceContext;

const isBusy = (err: unknown) => (err as { errcode?: number }).errcode === 5 || /database is locked/.test(String(err));

/** Retries a call the database refused because another connection holds its write lock. */
async function whenFree<T>(call: () => T): Promise<T> {
  for (;;) {
    try {
      return call();
    } catch (err) {
      if (!isBusy(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
}

/** Connections over one database file, each its own `node:sqlite` handle, so two writers race as two processes do: a transaction takes the write lock at its start and the other waits for it. */
export function sharedSqliteConnections(path: string, count: number) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string) => Database;
  };
  return Array.from({ length: count }, () => {
    const db = new DatabaseSync(path);
    let inTransaction = false;
    const run = async (sql: string, params: unknown[] = []) => {
      const call = () => {
        const statement = db.prepare(sql);
        if (/^\s*(SELECT|WITH)/i.test(sql) || /\bRETURNING\b/i.test(sql)) return { rows: statement.all(...params) as never[] };
        statement.run(...params);
        return { rows: [] as never[] };
      };
      return inTransaction ? call() : whenFree(call);
    };
    return {
      dialect: { placeholderStyle: "qmark" as const, quoteIdentifier: (name: string) => `"${name}"` },
      execute: run,
      /** Releases the file, which Windows will not delete while a handle holds it. */
      close: () => db.close(),
      async runInTransaction<T>(body: (bind: () => void) => Promise<T>): Promise<T> {
        await whenFree(() => db.exec("BEGIN IMMEDIATE"));
        inTransaction = true;
        try {
          const result = await body(() => undefined);
          db.exec("COMMIT");
          return result;
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        } finally {
          inTransaction = false;
        }
      },
    };
  });
}
