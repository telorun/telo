import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isInvokeError, type ResourceContext } from "@telorun/sdk";
import { McpHttpClient } from "../src/http-client-controller.js";

const URL = "http://mcp.example.com/mcp";

function jsonResponse(body: unknown, opts: { sessionId?: string; status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: opts.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(opts.sessionId ? { "mcp-session-id": opts.sessionId } : {}),
    },
  });
}

/**
 * Minimum ResourceContext surface McpHttpClient actually uses: `emitEvent` (for
 * the SessionTerminateFailed event) and `effect`, which is how the controller
 * hands back what undoes it.
 *
 * `unwind()` stands in for the kernel's teardown — it runs the inverses the
 * returned chain registered, newest first — so a test drives the session-DELETE
 * the same way the runtime does rather than calling a method directly.
 *
 * The sessionProvider is not looked up via the context: the kernel injects the
 * live instance into `manifest.sessionProvider` at Phase 5, which the external
 * tests below pass in directly.
 */
type TestCtx = ResourceContext & { unwind(): Promise<void> };

function makeCtx(): TestCtx {
  const inverses: Array<() => unknown> = [];
  const build = (steps: Array<(input: unknown) => any>): any => ({
    effect: (_reason: string, body: (input: unknown) => any) => build([...steps, body]),
    perform: async () => {
      let value: unknown;
      for (const step of steps) {
        const outcome = await step(value);
        inverses.push(outcome.inverse);
        value = outcome.result;
      }
      return { result: value, dispose: async () => {} };
    },
  });
  return {
    emitEvent: vi.fn(async () => {}),
    effect: (_reason: string, body: (input: unknown) => any) => build([body]),
    unwind: async () => {
      for (const inverse of [...inverses].reverse()) await inverse();
      inverses.length = 0;
    },
  } as unknown as TestCtx;
}

/** The context the client was constructed with — the same one the kernel would
 *  pass to `init()`, reached here so each test does not have to name it. */
function ctxOf(client: McpHttpClient): TestCtx {
  return (client as unknown as { ctx: TestCtx }).ctx;
}

/** Init the way the kernel does: call it, then execute what it returned. */
async function initClient(client: McpHttpClient): Promise<void> {
  await (client.init(ctxOf(client)) as unknown as { perform(): Promise<unknown> }).perform();
}

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("McpHttpClient (external sessionProvider mode)", () => {
  it("skips the initialize handshake and forwards provider sessionId", async () => {
    const provideSpy = vi.fn(async () => ({ sessionId: "from-provider" }));
    fetchMock.mockResolvedValue(
      jsonResponse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } }),
    );

    const client = new McpHttpClient(
      { metadata: { name: "Mcp" }, url: URL, sessionProvider: { name: "SessionRef", provide: provideSpy } },
      makeCtx(),
    );
    await initClient(client);
    const out = await client.invoke({ method: "tools/call", params: { name: "x", arguments: {} } });

    expect(out).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(provideSpy).toHaveBeenCalledOnce();
    // External mode means: exactly one POST per invoke (no initialize, no
    // notifications/initialized). Self-handshake mode would be 3 calls.
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["Mcp-Session-Id"]).toBe("from-provider");
  });

  it("calls provide() once per invoke (no per-client caching)", async () => {
    const provideSpy = vi.fn(async () => ({ sessionId: "rotating" }));
    // Each fetch call gets a fresh Response — Response bodies are
    // single-shot streams, so a shared instance can't be reused across
    // both invokes.
    fetchMock.mockImplementation(async () =>
      jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }),
    );

    const client = new McpHttpClient(
      { metadata: { name: "Mcp" }, url: URL, sessionProvider: { name: "SessionRef", provide: provideSpy } },
      makeCtx(),
    );
    await initClient(client);
    await client.invoke({ method: "tools/call", params: { name: "x" } });
    await client.invoke({ method: "tools/call", params: { name: "y" } });

    expect(provideSpy).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws ERR_MCP_TRANSPORT when the sessionProvider ref was never injected", async () => {
    // Phase 5 left `sessionProvider` as the bare ref (no live instance), so it
    // has no provide().
    const client = new McpHttpClient(
      { metadata: { name: "Mcp" }, url: URL, sessionProvider: "Missing" },
      makeCtx(),
    );
    await initClient(client);

    let err: unknown;
    try {
      await client.invoke({ method: "tools/call", params: { name: "x" } });
    } catch (e) {
      err = e;
    }
    expect(isInvokeError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("ERR_MCP_TRANSPORT");
  });

  it("throws ERR_MCP_TRANSPORT when the injected sessionProvider has no provide()", async () => {
    const client = new McpHttpClient(
      { metadata: { name: "Mcp" }, url: URL, sessionProvider: { name: "BadShape" } },
      makeCtx(),
    );
    await initClient(client);

    await expect(
      client.invoke({ method: "tools/call", params: { name: "x" } }),
    ).rejects.toMatchObject({ code: "ERR_MCP_TRANSPORT" });
  });

  it("throws ERR_MCP_PROTOCOL when the provider returns an empty sessionId", async () => {
    const client = new McpHttpClient(
      {
        metadata: { name: "Mcp" },
        url: URL,
        sessionProvider: { name: "EmptySid", provide: async () => ({ sessionId: "" }) },
      },
      makeCtx(),
    );
    await initClient(client);

    await expect(
      client.invoke({ method: "tools/call", params: { name: "x" } }),
    ).rejects.toMatchObject({ code: "ERR_MCP_PROTOCOL" });
  });

  it("teardown does NOT send DELETE in external-provider mode (sessions are owned upstream)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }));

    const client = new McpHttpClient(
      {
        metadata: { name: "Mcp" },
        url: URL,
        sessionProvider: { name: "S", provide: async () => ({ sessionId: "external" }) },
      },
      makeCtx(),
    );
    await initClient(client);
    await client.invoke({ method: "tools/call", params: { name: "x" } });

    fetchMock.mockClear();
    await ctxOf(client).unwind();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("McpHttpClient (self-handshake mode)", () => {
  it("runs initialize + notifications/initialized once, then reuses the cached session", async () => {
    const ctx = makeCtx();
    // First call: initialize → returns minted session id.
    // Second call: notifications/initialized → 202 (no body).
    // Third call: actual tools/call → result.
    // Fourth call: second tools/call → no re-handshake.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }, { sessionId: "sess-abc" }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 2, result: { content: [] } }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 3, result: { content: [] } }));

    const client = new McpHttpClient({ metadata: { name: "Mcp" }, url: URL }, ctx);
    await initClient(client);
    await client.invoke({ method: "tools/call", params: { name: "x" } });
    await client.invoke({ method: "tools/call", params: { name: "y" } });

    // 2 handshake calls + 2 tools/call POSTs = 4 fetches total.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // After the initialize response, the minted session id rides on every
    // follow-up request (including notifications/initialized).
    for (const [, init] of fetchMock.mock.calls.slice(1)) {
      expect(init.headers["Mcp-Session-Id"]).toBe("sess-abc");
    }
  });

  it("re-handshakes once after ERR_MCP_SESSION_INVALID, then re-runs the original request", async () => {
    const ctx = makeCtx();
    fetchMock
      // first handshake
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }, { sessionId: "old" }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      // first tools/call → 404 (session-invalid)
      .mockResolvedValueOnce(new Response("gone", { status: 404 }))
      // re-handshake
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 3, result: {} }, { sessionId: "new" }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      // retried tools/call → success
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 4, result: { content: [] } }));

    const client = new McpHttpClient({ metadata: { name: "Mcp" }, url: URL }, ctx);
    await initClient(client);
    const out = await client.invoke({ method: "tools/call", params: { name: "x" } });
    expect(out).toEqual({ content: [] });

    expect(fetchMock).toHaveBeenCalledTimes(6);
    // The retried tools/call (the last fetch) rides the new session, not the stale one.
    const [, lastInit] = fetchMock.mock.calls[5];
    expect(lastInit.headers["Mcp-Session-Id"]).toBe("new");
  });

  it("stateless server (no Mcp-Session-Id minted on initialize): handshake runs once, follow-ups send no header", async () => {
    const ctx = makeCtx();
    // initialize: 200 OK, no mcp-session-id header.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 2, result: { content: [] } }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 3, result: { content: [] } }));

    const client = new McpHttpClient({ metadata: { name: "Mcp" }, url: URL }, ctx);
    await initClient(client);
    await client.invoke({ method: "tools/call", params: { name: "x" } });
    await client.invoke({ method: "tools/call", params: { name: "y" } });

    // Exactly 4 calls: initialize + initialized notification + 2 tools/call.
    // Crucially, no second handshake on the second invoke — this is the
    // regression the handshakeComplete flag prevents (without it, null
    // sessionId would re-trigger the handshake every time).
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers["Mcp-Session-Id"]).toBeUndefined();
    }
  });

  it("teardown sends DELETE with the cached session ID", async () => {
    const ctx = makeCtx();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: {} }, { sessionId: "to-delete" }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 2, result: {} }))
      .mockResolvedValueOnce(new Response(null, { status: 200 })); // DELETE response

    const client = new McpHttpClient({ metadata: { name: "Mcp" }, url: URL }, ctx);
    await initClient(client);
    await client.invoke({ method: "tools/call", params: { name: "x" } });
    await ctxOf(client).unwind();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [, deleteInit] = fetchMock.mock.calls[3];
    expect(deleteInit.method).toBe("DELETE");
    expect(deleteInit.headers["Mcp-Session-Id"]).toBe("to-delete");
  });
});
