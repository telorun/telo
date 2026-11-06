import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCancellationSource, type ResourceContext } from "@telorun/sdk";
import { McpHttpClient } from "../src/http-client-controller.js";

const URL = "http://mcp.example.com/mcp";
const RETRY = { attempts: 2, initialDelay: 1, jitter: "none" as const };

const ctx = { log: { warn: vi.fn() } } as unknown as ResourceContext;

function reset(): never {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = Object.assign(new Error("read ECONNRESET"), {
    code: "ECONNRESET",
  });
  throw err;
}

function ok() {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(retry?: typeof RETRY & Record<string, unknown>) {
  return new McpHttpClient(
    {
      kind: "Mcp.HttpClient",
      metadata: { name: "Mcp" },
      url: URL,
      sessionProvider: { provide: async () => ({ sessionId: "s" }) },
      retry,
    },
    ctx,
  );
}

const call = { method: "tools/call", params: { name: "x" } };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("Mcp.HttpClient retry", () => {
  it("re-attempts a request that failed at the network layer", async () => {
    fetchMock.mockImplementationOnce(async () => reset()).mockImplementation(async () => ok());
    await expect(clientWith(RETRY).invoke(call)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails with ERR_MCP_TRANSPORT when no retry is configured", async () => {
    fetchMock.mockImplementation(async () => reset());
    await expect(clientWith().invoke(call)).rejects.toMatchObject({ code: "ERR_MCP_TRANSPORT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up with the last failure once the attempts are spent", async () => {
    fetchMock.mockImplementation(async () => reset());
    await expect(clientWith(RETRY).invoke(call)).rejects.toMatchObject({ code: "ERR_MCP_TRANSPORT" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("re-attempts a gateway 503 but not a 500", async () => {
    fetchMock
      .mockImplementationOnce(async () => new Response("", { status: 503 }))
      .mockImplementation(async () => ok());
    await expect(clientWith(RETRY).invoke(call)).resolves.toEqual({ ok: true });

    fetchMock.mockReset().mockImplementation(async () => new Response("", { status: 500 }));
    await expect(clientWith(RETRY).invoke(call)).rejects.toMatchObject({ code: "ERR_MCP_TRANSPORT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never re-attempts a JSON-RPC error", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(clientWith(RETRY).invoke(call)).rejects.toMatchObject({ code: "ERR_MCP_JSON_RPC_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops waiting between attempts when the invocation is cancelled", async () => {
    fetchMock.mockImplementation(async () => reset());
    const source = createCancellationSource();
    const slow = clientWith({ ...RETRY, initialDelay: 60_000 });
    const pending = slow.invoke(call, { cancellation: source.token } as never);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    source.cancel("stop");
    await expect(pending).rejects.toMatchObject({ code: "ERR_INVOKE_CANCELLED" });
  });
});
