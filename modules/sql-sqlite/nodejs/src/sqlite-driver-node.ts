import Database from "better-sqlite3";
import type { SqliteDb } from "./sqlite-driver-interface.js";

export function openDatabase(file: string): SqliteDb {
  const db = new Database(file);

  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);

      return {
        reader: stmt.reader,
        all(params: ReadonlyArray<unknown>) {
          return stmt.all(...(params as unknown[]));
        },
        run(params: ReadonlyArray<unknown>) {
          const result = stmt.run(...(params as unknown[]));
          return {
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid,
          };
        },
        iterate(params: ReadonlyArray<unknown>) {
          return stmt.iterate(...(params as unknown[])) as IterableIterator<unknown>;
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
