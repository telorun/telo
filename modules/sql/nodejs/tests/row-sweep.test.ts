import { celDurationFromNanos, type ResourceContext } from "@telorun/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RowSweep, SWEEP_BATCH_ROWS } from "../src/row-sweep.js";
import { SqlFragments } from "../src/sql-fragments.js";
import type { SqlConnection } from "../src/sql-connection.js";

const seconds = (n: number) => celDurationFromNanos(BigInt(n) * 1_000_000_000n);

interface Harness {
  sweep: RowSweep;
  statements: string[];
  warnings: string[];
  runInTransaction: ReturnType<typeof vi.fn>;
  stops: Array<() => Promise<void>>;
}

function harness(retention: number, removed: () => number | Promise<number> | Error): Harness {
  const statements: string[] = [];
  const warnings: string[] = [];
  const runInTransaction = vi.fn(async (body: (bind: (entry: unknown) => void) => Promise<unknown>) =>
    body(() => {}),
  );
  const connection = {
    runInTransaction,
    executeTemplate: vi.fn(async (fragments: string[]) => {
      statements.push(fragments.join("?"));
      const count = removed();
      if (count instanceof Error) throw count;
      return { count: await count };
    }),
    toRowCount: (result: { count: number }) => result.count,
  } as unknown as SqlConnection;
  const stops: Array<() => Promise<void>> = [];
  const ctx = {
    self: { ref: { kind: "Test.Owner" } },
    log: { warn: (message: string) => warnings.push(message) },
    effect: (_reason: string, body: () => Promise<{ result: unknown; inverse: () => Promise<void> }>) => ({
      perform: async () => {
        const { inverse } = await body();
        stops.push(inverse);
      },
    }),
  } as unknown as ResourceContext;
  const sweep = new RowSweep({
    ctx,
    connection,
    retention: seconds(retention),
    batchStatement: () => new SqlFragments().text("DELETE FROM t"),
    failureMessage: "sweep failed",
    logAttributes: {},
  });
  return { sweep, statements, warnings, runInTransaction, stops };
}

describe("RowSweep", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs one batch per pass when it comes back short, and waits the retention (at most 60 s) between passes", async () => {
    const { sweep, statements } = harness(3600, () => 3);
    await sweep.ensureStarted();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(statements).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(statements).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statements).toHaveLength(2);
  });

  it("clamps a sub-second retention up to one second", async () => {
    const { sweep, statements } = harness(0, () => 0);
    await sweep.ensureStarted();
    await vi.advanceTimersByTimeAsync(999);
    expect(statements).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(statements).toHaveLength(1);
  });

  it("keeps deleting full batches within a pass, at most twenty", async () => {
    const { sweep, statements } = harness(1, () => SWEEP_BATCH_ROWS);
    await sweep.ensureStarted();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statements).toHaveLength(20);
  });

  it("runs each batch in a transaction of its own", async () => {
    const { sweep, runInTransaction } = harness(1, () => 0);
    await sweep.ensureStarted();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runInTransaction).toHaveBeenCalledTimes(1);
  });

  it("starts once, however many callers ask", async () => {
    const { sweep, statements, stops } = harness(1, () => 0);
    await Promise.all([sweep.ensureStarted(), sweep.ensureStarted()]);
    await sweep.ensureStarted();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stops).toHaveLength(1);
    expect(statements).toHaveLength(1);
  });

  it("logs a failed pass as a warning and tries again at the next", async () => {
    let calls = 0;
    const { sweep, warnings, statements } = harness(1, () => (++calls === 1 ? new Error("down") : 0));
    await sweep.ensureStarted();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(warnings).toEqual(["sweep failed"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statements).toHaveLength(2);
  });

  it("runs no statement after teardown, and teardown waits for a pass in flight", async () => {
    let release!: () => void;
    const gate = new Promise<number>((resolve) => (release = () => resolve(0)));
    const { sweep, statements, stops } = harness(1, () => gate);
    await sweep.ensureStarted();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statements).toHaveLength(1);

    let stopped = false;
    const stopping = stops[0]!().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(statements).toHaveLength(1);
  });
});
