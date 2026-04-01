import { Database } from "bun:sqlite";
import type { SqliteDb } from "./sqlite-driver-interface.js";

export function openDatabase(file: string): SqliteDb {
  const db = new Database(file);

  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        reader: true,
        all(params: ReadonlyArray<unknown>) {
          return stmt.all(...(params as any[]));
        },
        run(params: ReadonlyArray<unknown>) {
          const result = stmt.run(...(params as any[]));
          return {
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid,
          };
        },
        iterate(params: ReadonlyArray<unknown>) {
          return stmt.iterate(...(params as any[])) as IterableIterator<unknown>;
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
