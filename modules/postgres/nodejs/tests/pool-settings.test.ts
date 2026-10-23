import type { ResourceContext } from "@telorun/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { create } from "../src/connection-controller.js";

const opened = vi.hoisted(() => [] as Array<{ options: Record<string, unknown>; query: unknown }>);

vi.mock("pg", async () => {
  const { vi } = await import("vitest");
  class Pool {
    readonly idleCount = 0;
    readonly totalCount = 0;
    readonly query = vi.fn(async () => ({ rows: [] }));
    constructor(readonly options: Record<string, unknown>) {
      opened.push(this);
    }
    on() {}
    async connect() {
      return {
        query: async () => ({
          command: "SELECT",
          rowCount: 1,
          rows: [{ versionNum: "160000", extensions: [] }],
        }),
        release() {},
      };
    }
    async end() {}
  }
  return { Pool, Client: class {} };
});

function testContext(): ResourceContext {
  const chain = (steps: Array<() => Promise<{ result: unknown }>>): any => ({
    effect: (_reason: string, body: () => Promise<{ result: unknown }>) => chain([...steps, body]),
    perform: async () => {
      for (const step of steps) await step();
    },
  });
  return {
    log: { debug() {} },
    effect: (_reason: string, body: () => Promise<{ result: unknown }>) => chain([body]),
    resolveNeed: () => ({ fields: { url: "postgres://app:secret@db.internal:5432/app" } }),
    verifyNeed() {},
  } as unknown as ResourceContext;
}

const settings = {
  min: 2,
  max: 5,
  idleTimeoutMs: 1000,
  connectionTimeoutMs: 5000,
  maxLifetimeMs: 60000,
  healthCheckMs: 200,
};
const computed = Object.fromEntries(
  Object.entries(settings).map(([field, value]) => [field, BigInt(value)]),
);

afterEach(() => {
  opened.length = 0;
  vi.useRealTimers();
});

describe.each([
  ["literal numbers", settings],
  ["int64s computed by CEL", computed],
])("pool settings written as %s", (_, pool) => {
  it("configure the pool and the liveness sweep", async () => {
    vi.useFakeTimers();
    const ctx = testContext();
    const connection = await create({ metadata: { name: "db", module: "App" }, pool }, ctx);
    await connection.init(ctx).perform();

    expect(opened).toHaveLength(1);
    expect(opened[0]!.options).toMatchObject({
      min: 2,
      max: 5,
      idleTimeoutMillis: 1000,
      connectionTimeoutMillis: 5000,
      maxLifetimeSeconds: 60,
    });
    // An empty pool below `min: 2` is topped up by one probe per missing connection.
    await vi.advanceTimersByTimeAsync(200);
    expect(opened[0]!.query).toHaveBeenCalledTimes(2);
  });
});
