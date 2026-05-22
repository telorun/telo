import {
  jsonRpcError,
  protocolError,
  sessionInvalidError,
  transportError,
} from "./errors.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number;
  result: Record<string, unknown>;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

/**
 * Monotonic request-id allocator scoped to a single transport instance. Used
 * by hand-rolled HTTP flow (external sessionProvider mode) and by callers
 * that route requests through the shared SDK Protocol.
 */
export function createIdAllocator(): () => number {
  let next = 1;
  return () => next++;
}

interface HttpPostResult {
  status: number;
  contentType: string;
  body: string;
  responseSessionId: string | null;
}

async function rawPost(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<HttpPostResult> {
  let resp: Response;
  try {
    resp = await fetch(url, { method: "POST", headers, body });
  } catch (err) {
    throw transportError(
      `MCP POST to ${url} failed at the network layer: ${(err as Error).message}`,
      { url, cause: (err as Error).message },
    );
  }
  const contentType = (resp.headers.get("content-type") ?? "").toLowerCase();
  const responseSessionId = resp.headers.get("mcp-session-id");
  const text = await resp.text();
  return { status: resp.status, contentType, body: text, responseSessionId };
}

/**
 * Parse the body of an MCP Streamable HTTP response. The server returns
 * either `application/json` (single envelope) or `text/event-stream` (one or
 * more SSE `data:` lines, each carrying a JSON envelope). We take the first
 * envelope and ignore subsequent ones — v1 calls are single-response RPCs.
 */
function parseStreamableHttpBody(contentType: string, body: string): JsonRpcResponse {
  if (contentType.startsWith("application/json")) {
    try {
      return JSON.parse(body) as JsonRpcResponse;
    } catch (err) {
      throw protocolError(
        `MCP server returned malformed JSON envelope: ${(err as Error).message}`,
        { contentType, body },
      );
    }
  }
  if (contentType.startsWith("text/event-stream")) {
    const dataLines = body
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) {
      throw protocolError(
        "MCP server SSE response carried no data lines",
        { body },
      );
    }
    try {
      return JSON.parse(dataLines[0]) as JsonRpcResponse;
    } catch (err) {
      throw protocolError(
        `MCP server returned malformed SSE data line: ${(err as Error).message}`,
        { dataLine: dataLines[0] },
      );
    }
  }
  throw transportError(
    `MCP server returned unexpected Content-Type '${contentType}'`,
    { contentType, body },
  );
}

function isSuccess(env: JsonRpcResponse): env is JsonRpcSuccess {
  return Object.prototype.hasOwnProperty.call(env, "result");
}

function isError(env: JsonRpcResponse): env is JsonRpcError {
  return Object.prototype.hasOwnProperty.call(env, "error");
}

function assertEnvelope(env: unknown): asserts env is JsonRpcResponse {
  if (
    !env ||
    typeof env !== "object" ||
    (env as Record<string, unknown>).jsonrpc !== "2.0"
  ) {
    throw protocolError("MCP envelope is missing or has wrong jsonrpc version", {
      envelope: env,
    });
  }
}

interface PostJsonRpcResult {
  /** Parsed `result` payload from the JSON-RPC success envelope. */
  result: Record<string, unknown>;
  /** Server-minted Mcp-Session-Id, if the server returned one. Only set on
   *  initialize responses against stateful endpoints. */
  responseSessionId: string | null;
}

/**
 * Send a single JSON-RPC POST to an MCP Streamable HTTP endpoint. Returns the
 * parsed `result` payload plus any Mcp-Session-Id the server included in the
 * response headers. Protocol / transport / session errors throw the matching
 * ERR_MCP_*. Unlike the SDK's StreamableHTTPClientTransport, this never opens
 * a server-pushed SSE GET stream, so teardown is deterministic and the
 * caller's Http.Server fastify close() can drain immediately.
 *
 * Sends one request (or one notification) per call. Batch JSON-RPC is not
 * supported in v1 — none of the dispatched methods (initialize, tools/call,
 * tools/list, notifications/initialized) compose into batches. Add batch
 * parsing when a v2 use-case actually needs it; the response-envelope
 * branches here would otherwise silently drop server-side errors.
 */
export async function postJsonRpc(
  url: string,
  baseHeaders: Record<string, string>,
  sessionId: string | null,
  request: JsonRpcRequest | JsonRpcNotification,
): Promise<PostJsonRpcResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...baseHeaders,
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  const { status, contentType, body, responseSessionId } = await rawPost(
    url,
    headers,
    JSON.stringify(request),
  );

  if (status === 404 || status === 410) {
    throw sessionInvalidError(
      `MCP server rejected session ${sessionId ?? "<none>"} with HTTP ${status}`,
      { status, sessionId },
    );
  }
  if (status >= 400) {
    throw transportError(
      `MCP server returned HTTP ${status} on JSON-RPC POST`,
      { status, body },
    );
  }

  // Notifications produce HTTP 202 with no body — no result expected.
  if (!("id" in request)) {
    return { result: {}, responseSessionId };
  }

  const envelope = parseStreamableHttpBody(contentType, body);
  assertEnvelope(envelope);

  if (isError(envelope)) {
    if (envelope.error.code === -32001 || envelope.error.code === -32002) {
      // Session-invalid mapped via JSON-RPC error code (see mcp-server's
      // HttpEndpoint: -32001 unknown session, -32002 missing header).
      throw sessionInvalidError(envelope.error.message, {
        jsonRpcCode: envelope.error.code,
        sessionId,
      });
    }
    throw jsonRpcError(envelope.error.code, envelope.error.message, envelope.error.data);
  }
  if (!isSuccess(envelope)) {
    throw protocolError("MCP envelope has neither result nor error", { envelope });
  }
  return { result: envelope.result, responseSessionId };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}
