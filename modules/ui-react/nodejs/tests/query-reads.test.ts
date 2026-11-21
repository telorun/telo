// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { QueryReads, type Holder } from "../src/browser/query-reads.js";

describe("query reads", () => {
  it("hold at most one read for a node whose body changes a thousand times", () => {
    const reads = new QueryReads(
      () => new Promise<Response>(() => {}),
      () => () => {},
    );
    const holder: Holder = { visible: true, watchers: [], own: () => {}, say: (key) => key };
    const terms = { id: "report", schema: { type: "object" }, reloadOn: [] };
    let release = () => {};
    let most = 0;
    for (let day = 0; day < 1000; day++) {
      const request = { method: "QUERY" as const, url: "/api/report", changeAt: "/api/report", body: { value: { day } } };
      release();
      release = reads.hold(QueryReads.keyOf(terms.id, request), terms, request, holder);
      most = Math.max(most, reads.size);
    }
    release();
    expect([most, reads.size]).toEqual([1, 0]);
  });

  it("settle a read whose validation throws as a refused answer", async () => {
    const reads = new QueryReads(
      async () => new Response(JSON.stringify({ a: "x" }), { status: 200, headers: { "content-type": "application/json" } }),
      () => () => {},
    );
    const holder: Holder = { visible: true, watchers: [], own: () => {}, say: (key) => key };
    const terms = { id: "report", schema: { type: "object", properties: { a: { type: "string", pattern: "(" } } }, reloadOn: [] };
    const request = { method: "GET" as const, url: "/api/report" };
    const key = QueryReads.keyOf(terms.id, request);
    const notified = new Promise<void>((resolve) => reads.subscribe(key, resolve));
    reads.hold(key, terms, request, holder);
    await notified;
    const outcome = reads.state(key)?.outcome;
    expect(outcome?.ok).toBe(false);
    expect(outcome && !outcome.ok && outcome.error.code).toBe("ERR_UI_RESPONSE_INVALID");
  });
});
