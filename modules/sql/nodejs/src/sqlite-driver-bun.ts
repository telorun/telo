import { Database } from "bun:sqlite";
import type { SqliteDb } from "./sqlite-driver-interface.js";

export function openDatabase(file: string): SqliteDb {
  const db = new Database(file);
  return {
    prepare(sql: string) {
      const stmt = db.query(sql);
      return {
        all(...params: unknown[]) {
          return stmt.all(...params) as Record<string, unknown>[];
        },
        run(...params: unknown[]) {
          const result = stmt.run(...params);
          return { changes: result.changes };
        },
      };
    },
    exec(sql: string) {
      db.run(sql);
    },
    close() {
      db.close();
    },
  };
}
