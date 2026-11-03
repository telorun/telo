import { createRequire } from "node:module";
import { celDurationFromNanos, celTimestamp, isCelDuration, type CelDuration } from "@telorun/sdk";
import { readTimestampColumn, SqlFragments } from "@telorun/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SQLITE_SKIP_LOCKED_CLAUSE,
  sqliteCurrentInstant,
  sqliteCurrentInstantPlus,
  sqliteInstantParameter,
} from "../src/schema/sqlite-instants.js";

// Node's built-in SQLite, loaded through `require`: the bundler this runner uses
// does not know `node:sqlite` as a built-in and would resolve it as a package.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => Db;
};
interface Db {
  exec(sql: string): void;
  prepare(sql: string): { all(...values: unknown[]): unknown[] };
  close(): void;
}

const DESCRIBE = 'SQLite.Schema "test"';

function duration(nanos: bigint): CelDuration {
  const built = celDurationFromNanos(nanos);
  if (!isCelDuration(built)) throw new Error("duration out of range");
  return built;
}

/** Runs fragments as `executeTemplate` does under the qmark placeholder style. */
function all(db: Db, statement: SqlFragments): Record<string, unknown>[] {
  return db.prepare(statement.fragments.join("?")).all(...statement.boundValues) as Record<string, unknown>[];
}

let db: Db;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
});
afterEach(() => {
  db.close();
});

describe("SQLite instants", () => {
  // SQLite's clock and its date arithmetic are both to the millisecond, and
  // 'now' is one reading for the whole statement, so a shift of one millisecond
  // either way is visible and exact; a duration or an instant finer than that
  // is truncated (toward zero, and toward the past).
  it("stores shifted and bound instants in an order consistent with the current instant", () => {
    const bound = (seconds: bigint, nanos: number) => {
      const timestamp = celTimestamp(seconds, nanos);
      if (!("seconds" in timestamp)) throw new Error("timestamp out of range");
      return sqliteInstantParameter(timestamp, DESCRIBE);
    };
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    db.exec("CREATE TABLE instants (label TEXT NOT NULL, at TEXT NOT NULL)");
    all(
      db,
      new SqlFragments()
        .text(`INSERT INTO instants (label, at) VALUES ('now', ${sqliteCurrentInstant()}), ('later', `)
        .append(sqliteCurrentInstantPlus(duration(1_999_999n), DESCRIBE))
        .text("), ('earlier', ")
        .append(sqliteCurrentInstantPlus(duration(-1_000_000n), DESCRIBE))
        .text("), ('past', ")
        .append(bound(nowSeconds - 60n, 999_999_999))
        .text("), ('future', ")
        .append(bound(nowSeconds + 60n, 0))
        .text("), ('epoch', ")
        .append(bound(0n, 123_999_999))
        .text(")"),
    );

    const rows = db.prepare("SELECT label, at FROM instants ORDER BY at").all() as { label: string; at: string }[];
    expect(rows.map((row) => row.label)).toEqual(["epoch", "past", "earlier", "now", "later", "future"]);
    const at = Object.fromEntries(rows.map((row) => [row.label, readTimestampColumn(row.at).getTime()]));
    expect(at.later - at.now).toBe(1);
    expect(at.earlier - at.now).toBe(-1);
    expect(rows[0].at).toBe("1970-01-01T00:00:00.123Z");
  });

  it("refuses a shift SQLite's date functions cannot represent", () => {
    const tenThousandYears = {
      ...duration(0n),
      seconds: 315_576_000_000n,
    } as CelDuration;
    expect(() => sqliteCurrentInstantPlus(tenThousandYears, DESCRIBE)).toThrow(
      /leaves years 0000–9999/,
    );
  });
});

describe("SQLite lock skipping", () => {
  it("composes into UPDATE and DELETE over a limited row selection", () => {
    db.exec("CREATE TABLE jobs (id INTEGER PRIMARY KEY, claimed INTEGER NOT NULL DEFAULT 0)");
    db.exec("INSERT INTO jobs (id) VALUES (1), (2), (3)");
    const selection = `SELECT id FROM jobs WHERE claimed = 0 ORDER BY id LIMIT 2 ${SQLITE_SKIP_LOCKED_CLAUSE}`;

    const claimed = db
      .prepare(`UPDATE jobs SET claimed = 1 WHERE id IN (${selection}) RETURNING id`)
      .all() as { id: number }[];
    expect(claimed.map((row) => row.id).sort()).toEqual([1, 2]);

    const purged = db
      .prepare(`DELETE FROM jobs WHERE id IN (${selection}) RETURNING id`)
      .all() as { id: number }[];
    expect(purged).toEqual([{ id: 3 }]);
  });
});
