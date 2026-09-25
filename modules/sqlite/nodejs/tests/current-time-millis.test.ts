import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { sqliteDialect } from "../src/connection-controller.js";

// Node's built-in SQLite, loaded through `require`: the bundler this runner uses
// does not know `node:sqlite` as a built-in and would resolve it as a package.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    prepare(sql: string): { get(): unknown };
    close(): void;
  };
};

describe("sqliteDialect.renderCurrentTimeMillis", () => {
  it("renders the database's current time in epoch milliseconds", () => {
    const db = new DatabaseSync(":memory:");
    const before = Date.now();
    const row = db.prepare(`SELECT ${sqliteDialect.renderCurrentTimeMillis()} AS now_ms`).get() as { now_ms: number };
    const after = Date.now();
    db.close();

    expect(Number.isInteger(row.now_ms)).toBe(true);
    // julianday resolves to about a millisecond; allow that on both sides.
    expect(row.now_ms).toBeGreaterThanOrEqual(before - 2);
    expect(row.now_ms).toBeLessThanOrEqual(after + 2);
  });
});
