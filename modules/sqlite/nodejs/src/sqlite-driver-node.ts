import Database from "better-sqlite3";
import { toSqliteBindings } from "./sqlite-bound-parameters.js";
import type { SqliteDb } from "./sqlite-driver-interface.js";

export function openDatabase(file: string, addon: string): SqliteDb {
  const db = new Database(file, { nativeBinding: addon });
  // Zero: the engine's own wait blocks the thread, which stalls every other
  // connection in this process; the connection waits between statements instead.
  db.pragma("busy_timeout = 0");
  // Per connection, and ignored inside a transaction, so set at open.
  db.pragma("foreign_keys = ON");

  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);

      return {
        reader: stmt.reader,
        all(params: ReadonlyArray<unknown>) {
          return stmt.all(...toSqliteBindings(params));
        },
        run(params: ReadonlyArray<unknown>) {
          const result = stmt.run(...toSqliteBindings(params));
          return {
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid,
          };
        },
        iterate(params: ReadonlyArray<unknown>) {
          return stmt.iterate(...toSqliteBindings(params)) as IterableIterator<unknown>;
        },
      };
    },
    exec(sql: string) {
      db.exec(sql);
    },
    busyTimeout(ms: number) {
      db.pragma(`busy_timeout = ${ms}`);
    },
    close() {
      db.close();
    },
  };
}
