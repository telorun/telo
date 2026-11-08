import { describe, expect, it } from "vitest";
import { create } from "../src/suite.js";

function fakeContext(invoke: () => Promise<unknown>, validate: (result: unknown) => unknown) {
  let out = "";
  const exits: number[] = [];
  const ctx: any = {
    stdout: { write: (t: string) => (out += t) },
    stderr: { write: () => {} },
    ensureKindRef: (_: unknown, name: string) => ({ kind: "Fake.Call", name }),
    invoke,
    expandValue: (_: unknown, scope: { result: unknown }) => validate(scope.result),
    requestExit: (code: number) => exits.push(code),
  };
  return { ctx, output: () => out, exits };
}

async function run(format: "json" | "table", invoke: () => Promise<unknown>, validate = true) {
  const { ctx, output } = fakeContext(invoke, (r) => Number((r as any).status) === 200);
  const suite = await create(
    {
      metadata: { name: "s" },
      requests: 4,
      report: { format },
      scenarios: [{ name: "api", invoke: { kind: "Fake.Call" }, ...(validate ? { validate: true } : {}) }],
    } as any,
    ctx,
  );
  await suite.init();
  await suite.run();
  return output();
}

describe("Benchmark.Suite report", () => {
  it("groups a failed validate by its status and samples the response body", async () => {
    const text = await run("json", async () => ({ status: 500n, body: { code: "ERR_SQL_BUSY" } }));
    const api = JSON.parse(text).api;
    expect(api.total).toBe(4);
    expect(api.errors).toEqual({
      count: 4,
      rate: 1,
      groups: [
        {
          code: "VALIDATE_FALSE",
          message: "validate returned false: status 500",
          count: 4,
          sample: '{"code":"ERR_SQL_BUSY"}',
        },
      ],
    });
    expect(Object.keys(api)).toEqual(["total", "rps", "p50", "p95", "p99", "errors"]);
  });

  it("groups a thrown failure by its code and message and samples its data", async () => {
    const error = Object.assign(new Error("database is locked"), { code: "ERR_SQL_BUSY", data: { retry: true } });
    const api = JSON.parse(await run("json", async () => Promise.reject(error), false)).api;
    expect(api.errors.groups).toEqual([
      { code: "ERR_SQL_BUSY", message: "database is locked", count: 4, sample: '{"retry":true}' },
    ]);
  });

  it("prints the error groups after the table", async () => {
    const text = await run("table", async () => ({ status: 500 }));
    expect(text).toMatch(/Scenario\s+Code\s+Count\s+Message\s+Sample/);
    expect(text).toMatch(/api\s+VALIDATE_FALSE\s+4\s+validate returned false: status 500/);
  });
});
