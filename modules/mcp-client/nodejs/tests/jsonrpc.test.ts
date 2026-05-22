import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isInvokeError } from "@telorun/sdk";
import { postJsonRpc } from "../src/jsonrpc.js";

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;
const URL = "http://mcp.example.com/mcp";
const REQ = { jsonrpc: "2.0" as const, id: 7, method: "tools/call", params: { name: "x" } };

function jsonResponse(body: unknown, opts: { sessionId?: string; status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: opts.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(opts.sessionId ? { "mcp-session-id": opts.sessionId } : {}),
    },
  });
}

function sseResponse(envelope: unknown) {
  return new Response(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function plainResponse(status: number, body = "") {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("postJsonRpc", () => {
  it("parses application/json success envelopes", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "ok" }] } }),
    );

    const out = await postJsonRpc(URL, {}, null, REQ);

    expect(out.result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(out.responseSessionId).toBeNull();
  });

  it("parses text/event-stream success envelopes (first data line wins)", async () => {
    fetchMock.mockResolvedValue(
      sseResponse({ jsonrpc: "2.0", id: 7, result: { tools: [{ name: "echo" }] } }),
    );

    const out = await postJsonRpc(URL, {}, null, REQ);

    expect(out.result).toEqual({ tools: [{ name: "echo" }] });
  });

  it("forwards Mcp-Session-Id on the request when sessionId is provided", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 7, result: {} }));

    await postJsonRpc(URL, { authorization: "Bearer x" }, "sess-123", REQ);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["Mcp-Session-Id"]).toBe("sess-123");
    expect(init.headers["authorization"]).toBe("Bearer x");
  });

  it("captures the response Mcp-Session-Id header (initialize handshake path)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ jsonrpc: "2.0", id: 7, result: {} }, { sessionId: "minted-abc" }),
    );

    const out = await postJsonRpc(URL, {}, null, REQ);

    expect(out.responseSessionId).toBe("minted-abc");
  });

  it("maps HTTP 404 to ERR_MCP_SESSION_INVALID", async () => {
    fetchMock.mockResolvedValue(plainResponse(404, "session expired"));

    await expect(postJsonRpc(URL, {}, "stale", REQ)).rejects.toMatchObject({
      code: "ERR_MCP_SESSION_INVALID",
    });
  });

  it("maps HTTP 410 to ERR_MCP_SESSION_INVALID", async () => {
    fetchMock.mockResolvedValue(plainResponse(410));

    await expect(postJsonRpc(URL, {}, "stale", REQ)).rejects.toMatchObject({
      code: "ERR_MCP_SESSION_INVALID",
    });
  });

  it("maps other 4xx/5xx to ERR_MCP_TRANSPORT", async () => {
    fetchMock.mockResolvedValue(plainResponse(503, "down"));

    await expect(postJsonRpc(URL, {}, null, REQ)).rejects.toMatchObject({
      code: "ERR_MCP_TRANSPORT",
      data: { status: 503 },
    });
  });

  it("maps JSON-RPC -32001 to ERR_MCP_SESSION_INVALID", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32001, message: "unknown session" },
      }),
    );

    await expect(postJsonRpc(URL, {}, "stale", REQ)).rejects.toMatchObject({
      code: "ERR_MCP_SESSION_INVALID",
    });
  });

  it("maps JSON-RPC -32002 to ERR_MCP_SESSION_INVALID", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32002, message: "missing session header" },
      }),
    );

    await expect(postJsonRpc(URL, {}, null, REQ)).rejects.toMatchObject({
      code: "ERR_MCP_SESSION_INVALID",
    });
  });

  it("maps other JSON-RPC errors to ERR_MCP_JSON_RPC_ERROR with structured data", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32601, message: "method not found", data: { method: "x" } },
      }),
    );

    let err: unknown;
    try {
      await postJsonRpc(URL, {}, null, REQ);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(isInvokeError(err)).toBe(true);
    expect(err).toMatchObject({
      code: "ERR_MCP_JSON_RPC_ERROR",
      data: { code: -32601, message: "method not found", data: { method: "x" } },
    });
  });

  it("maps network failures to ERR_MCP_TRANSPORT", async () => {
    fetchMock.mockRejectedValue(new TypeError("connect ECONNREFUSED"));

    await expect(postJsonRpc(URL, {}, null, REQ)).rejects.toMatchObject({
      code: "ERR_MCP_TRANSPORT",
    });
  });

  it("rejects malformed JSON envelopes as ERR_MCP_PROTOCOL", async () => {
    fetchMock.mockResolvedValue(
      new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
    );

    await expect(postJsonRpc(URL, {}, null, REQ)).rejects.toMatchObject({
      code: "ERR_MCP_PROTOCOL",
    });
  });

  it("rejects empty SSE responses as ERR_MCP_PROTOCOL", async () => {
    fetchMock.mockResolvedValue(
      new Response("event: ping\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    await expect(postJsonRpc(URL, {}, null, REQ)).rejects.toMatchObject({
      code: "ERR_MCP_PROTOCOL",
    });
  });

  it("rejects unexpected Content-Type as ERR_MCP_TRANSPORT", async () => {
    fetchMock.mockResolvedValue(
      new Response("hello", { status: 200, headers: { "content-type": "text/html" } }),
    );

    await expect(postJsonRpc(URL, {}, null, REQ)).rejects.toMatchObject({
      code: "ERR_MCP_TRANSPORT",
    });
  });

  it("rejects envelopes that have neither result nor error as ERR_MCP_PROTOCOL", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 7 }));

    await expect(postJsonRpc(URL, {}, null, REQ)).rejects.toMatchObject({
      code: "ERR_MCP_PROTOCOL",
    });
  });

  it("treats notifications (no id) as fire-and-forget — no envelope parse, no result", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));

    const out = await postJsonRpc(URL, {}, "sess", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    expect(out.result).toEqual({});
  });
});
