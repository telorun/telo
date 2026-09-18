import Database from "better-sqlite3";
import { toSqliteBindings } from "./sqlite-bound-parameters.js";
import type { SqliteDb } from "./sqlite-driver-interface.js";

export function openDatabase(file: string, addon: string): SqliteDb {
  const db = new Database(file, { nativeBinding: addon });
  // Wait for a lock rather than failing on it. Two applications over one file is
  // an ordinary shape — the same app run twice, a worker beside a server — and
  // without this the second one's very first write raises "database is locked"
  // the instant the first holds the file. Stated here rather than left to a
  // driver default, because the two drivers do not agree on one.
  db.pragma("busy_timeout = 5000");

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
    close() {
      db.close();
    },
  };
}
