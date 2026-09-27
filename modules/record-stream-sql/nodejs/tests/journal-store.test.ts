import { createCancellationSource } from "@telorun/sdk";
import type { ResourceContext } from "@telorun/sdk";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { create } from "../src/journal-store.js";

/** A connection that records every statement and answers the few the wait issues. */
function fakeConnection(dialect: Record<string, unknown>) {
  const statements: string[] = [];
  const answer = async (sql: string) => {
    statements.push(sql);
    if (sql.startsWith("SELECT version")) return { rows: [{ version: "v1" }], numAffectedRows: 0n };
    return { rows: [], numAffectedRows: 0n };
  };
  const connection = {
    dialect: { placeholderStyle: "qmark" as const, quoteIdentifier: (name: string) => `[${name}]`, ...dialect },
    execute: answer,
    executeUncommitted: answer,
    runInTransaction: async <T>(body: (bind: () => void) => Promise<T>) => body(() => undefined),
    toRowCount: () => 0,
  };
  return { connection, statements };
}

const ctx = {
  resolveRef: (value: unknown) => value,
  self: { id: "store", ref: { kind: "RecordStreamSql.JournalStore", name: "store" } },
} as unknown as ResourceContext;

const clock = { renderCurrentTimeMillis: () => "CLOCK_MS" };

async function initialized(dialect: Record<string, unknown>, createTable: boolean) {
  const { connection, statements } = fakeConnection(dialect);
  const store = await create({ metadata: { name: "store" }, connection, createTable }, ctx);
  await store.init(ctx);
  return { store, statements };
}

describe("RecordStreamSql.JournalStore", () => {
  it("issues no statement at init when its tables are not its to create", async () => {
    const { statements } = await initialized(clock, false);
    expect(statements).toEqual([]);
  });

  it("refuses a dialect with no clock before issuing any statement", async () => {
    const { connection, statements } = fakeConnection({});
    const store = await create({ metadata: { name: "store" }, connection, createTable: true }, ctx);
    await expect(store.init(ctx)).rejects.toMatchObject({
      code: "ERR_INVALID_VALUE",
      message: expect.stringContaining("renderCurrentTimeMillis"),
    });
    expect(statements).toEqual([]);
  });

  it("reads the clock and names its tables through the dialect", async () => {
    const { store, statements } = await initialized(clock, true);
    expect(statements.join("\n")).toContain("[record_stream_journal_keys]");
    await store.putIfAbsent("k", "header");
    expect(statements.at(-1)).toContain("CLOCK_MS");
  });

  it("issues no statement once a wait is cancelled, and leaves no waiter entry behind", async () => {
    const { store, statements } = await initialized(clock, false);
    const source = createCancellationSource();
    const waiting = store.wait("live", "v1", 60_000, source.token);
    // Let the first poll run and the wait settle into its pause.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = statements.length;
    source.cancel("stop");
    await waiting;
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(statements.length).toBe(before);
    expect((store as unknown as { waiters: Map<string, unknown> }).waiters.size).toBe(0);
  });
});

/** The connection slice the store uses, over an in-memory SQLite database. The
 *  clock expression is the SQLite backend's own. */
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): { changes: number | bigint } };
}

function sqliteConnection() {
  // Loaded through require: vite's resolver does not know the `node:sqlite` built-in.
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  const db = new DatabaseSync(":memory:");
  const run = async (sql: string, params: unknown[] = []) => {
    const statement = db.prepare(sql);
    const values = params;
    if (/^\s*SELECT/i.test(sql)) return { rows: statement.all(...values) as never[] };
    return { rows: [], numAffectedRows: statement.run(...values).changes };
  };
  return {
    dialect: {
      placeholderStyle: "qmark" as const,
      quoteIdentifier: (name: string) => `"${name}"`,
      renderCurrentTimeMillis: () => "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)",
    },
    execute: run,
    executeUncommitted: run,
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
    toRowCount: (result: { numAffectedRows?: unknown }) => Number(result.numAffectedRows ?? 0),
  };
}

describe("RecordStreamSql.JournalStore lastId", () => {
  it("is reported the same by scan as by read for the same key", async () => {
    const store = await create({ metadata: { name: "store" }, connection: sqliteConnection(), createTable: true }, ctx);
    await store.init(ctx);
    let version = (await store.putIfAbsent("k", "header"))!;
    for (const record of ["a", "b", "c"]) version = (await store.compareAndAppend("k", version, record))!.version;

    const read = (await store.read("k", 0, 0)).header!;
    const scanned = (await store.scan(0, null, 10)).headers.find((header) => header.key === "k")!;
    expect(read.lastId).toBe(3);
    expect(scanned.lastId).toBe(read.lastId);
  });
});
