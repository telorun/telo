import { Database } from "bun:sqlite";
import type { SqliteDb } from "@telorun/sql";

export function openDatabase(file: string): SqliteDb {
  const db = new Database(file);

  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        // A statement is a reader iff it yields a result set. bun:sqlite has no
        // `reader` flag (better-sqlite3 does), so derive it from the output
        // columns: SELECT and `... RETURNING` expose column names, plain
        // INSERT/UPDATE/DELETE expose none. Kysely routes readers through
        // `all()` and everything else through `run()` — getting this wrong sent
        // every mutation down the `all()` path, so `numAffectedRows` was never
        // reported (rowCount always 0).
        reader: stmt.columnNames.length > 0,
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
