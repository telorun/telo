import { createCancellationSource } from "@telorun/sdk";
import type { ResourceContext } from "@telorun/sdk";
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
