import { Database } from "bun:sqlite";
import type { SqliteDb } from "./sqlite-driver-interface.js";

export function openDatabase(file: string): SqliteDb {
  const db = new Database(file);
  return {
    prepare(sql: string) {
      return {
        all(...params: unknown[]) {
          return db.prepare(sql).all(...params) as Record<string, unknown>[];
        },
        run(...params: unknown[]) {
          const result = db.prepare(sql).run(...params);
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
