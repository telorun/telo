import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { httpRunnerAdapter } from "../adapter";
import type { RunRequest } from "../../../types";

/**
 * The editor's half of the watch contract: which routes it calls and what it
 * sends. Asserted against a stubbed fetch rather than a live runner, because
 * what can silently drift here is the SHAPE — a wrong route or a missing `mode`
 * fails as "watch just doesn't work", with no error anywhere.
 */
const CONFIG = { baseUrl: "http://runner.test", image: "img", pullPolicy: "missing" as const };

const REQUEST: RunRequest = {
  bundle: { entryRelativePath: "telo.yaml", files: [{ relativePath: "telo.yaml", contents: "x" }] },
};

let calls: Array<{ url: string; method: string; body: unknown }>;

function stubFetch(responder: (url: string, method: string) => Response): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return responder(url, method);
  });
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = [];
  // The session constructor opens an SSE stream and a WebSocket; neither exists
  // in the test environment and neither is what this asserts.
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      removeEventListener() {}
      close() {}
      readyState = 0;
      static readonly CLOSED = 2;
    },
  );
  vi.stubGlobal(
    "WebSocket",
    class {
      addEventListener() {}
      close() {}
      readyState = 0;
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("watch sessions over the /v1 contract", () => {
  it("sends mode:watch only when watch was asked for", async () => {
    stubFetch(() => json({ sessionId: "s1", streamUrl: "/v1/sessions/s1/events", createdAt: "" }));

    await httpRunnerAdapter.start({ ...REQUEST, mode: "watch" }, CONFIG);
    expect((calls[0]!.body as { mode?: string }).mode).toBe("watch");

    calls = [];
    await httpRunnerAdapter.start(REQUEST, CONFIG);
    // Omitted, not `"run"` — a runner too old to know the field is unaffected.
    expect(calls[0]!.body as object).not.toHaveProperty("mode");
  });

  it("exposes the watch operations only on a watch session", async () => {
    stubFetch(() => json({ sessionId: "s1", streamUrl: "/v1/sessions/s1/events", createdAt: "" }));

    const watch = await httpRunnerAdapter.start({ ...REQUEST, mode: "watch" }, CONFIG);
    expect(watch.isWatch).toBe(true);
    expect(watch.syncWorkspace).toBeTypeOf("function");
    expect(watch.reload).toBeTypeOf("function");
    expect(watch.resume).toBeTypeOf("function");

    const plain = await httpRunnerAdapter.start(REQUEST, CONFIG);
    // The routes 409 on a run session, so the absence keeps the failure at the
    // call site rather than on the wire.
    expect(plain.isWatch).toBeUndefined();
    expect(plain.syncWorkspace).toBeUndefined();
    expect(plain.reload).toBeUndefined();
  });

  it("posts a change set to the workspace route", async () => {
    stubFetch((url) =>
      url.endsWith("/workspace")
        ? json({ written: 1, deleted: 0 })
        : json({ sessionId: "s1", streamUrl: "/v1/sessions/s1/events", createdAt: "" }),
    );

    const session = await httpRunnerAdapter.start({ ...REQUEST, mode: "watch" }, CONFIG);
    calls = [];
    await session.syncWorkspace!({ write: [{ path: "telo.yaml", content: "edited" }] });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://runner.test/v1/sessions/s1/workspace");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ write: [{ path: "telo.yaml", content: "edited" }] });
  });

  it("surfaces a workspace failure rather than swallowing it", async () => {
    stubFetch((url) =>
      url.endsWith("/workspace")
        ? json({ error: "not_running", message: "session has no live workspace" }, 409)
        : json({ sessionId: "s1", streamUrl: "/v1/sessions/s1/events", createdAt: "" }),
    );

    const session = await httpRunnerAdapter.start({ ...REQUEST, mode: "watch" }, CONFIG);
    await expect(session.syncWorkspace!({ write: [] })).rejects.toThrow(
      "session has no live workspace",
    );
  });

  it("reads a resume 404 as 'start a fresh session', not as an error", async () => {
    stubFetch((url) =>
      url.endsWith("/resume")
        ? json({ error: "not_suspended" }, 404)
        : json({ sessionId: "s1", streamUrl: "/v1/sessions/s1/events", createdAt: "" }),
    );

    const session = await httpRunnerAdapter.start({ ...REQUEST, mode: "watch" }, CONFIG);
    // The checkpoint lives in the runner's memory, so a restart loses it. The
    // editor holds the authoritative workspace and re-seeds — by design.
    await expect(session.resume!()).resolves.toBe(false);
  });

  it("recovers watch-ness from the session document on re-attach", async () => {
    stubFetch(() => json({ status: { kind: "running" }, mode: "watch" }));

    const session = await httpRunnerAdapter.attach!("s1", CONFIG);
    // A page reload has no memory of what was requested — the runner's session
    // document is the authority.
    expect(session?.isWatch).toBe(true);
    expect(session?.reload).toBeTypeOf("function");
  });
});
