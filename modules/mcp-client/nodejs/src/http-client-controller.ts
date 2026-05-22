import {
  type ControllerContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";

import {
  protocolError,
  sessionInvalidError,
  transportError,
} from "./errors.js";
import {
  createIdAllocator,
  postJsonRpc,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "./jsonrpc.js";

const DEFAULT_CLIENT_INFO = { name: "telo-mcp-client", version: "0.1.0" };
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

interface ClientInfo {
  name: string;
  version: string;
}

interface HttpClientManifest {
  metadata: { name: string };
  url: string;
  headers?: Record<string, string>;
  sessionProvider?: string;
  clientInfo?: ClientInfo;
  protocolVersion?: string;
}

interface InvokeInput {
  method: string;
  params?: Record<string, unknown>;
}

interface SessionProviderInstance extends ResourceInstance {
  provide(): Promise<{ sessionId: string }>;
}

export async function register(_ctx: ControllerContext): Promise<void> {}

/**
 * Mcp.HttpClient — Streamable HTTP transport for MCP, hand-rolled on top of
 * fetch. Deliberately does NOT use @modelcontextprotocol/sdk's Client +
 * StreamableHTTPClientTransport because that transport opens a long-lived
 * server-pushed SSE GET stream on `notifications/initialized`. That open
 * connection deadlocks against Fastify's `server.close()` in the host's
 * Http.Server: app.close() waits for in-flight responses to drain before
 * teardown unblocks, but the SSE GET can only close once Mcp.HttpClient.
 * teardown() runs — and that won't run until the surrounding `with:` scope
 * (which owns Http.Server) tears down. Hand-rolling means one fetch per RPC
 * and no persistent connections, so teardown is deterministic.
 *
 * v1 covers tools/call + tools/list per the Mcp.Client.inputType enum.
 * Server→client notifications are an explicit non-goal (see the module's
 * plans/mcp-client-initial-design.md §2).
 */
export class McpHttpClient {
  private readonly nextId = createIdAllocator();
  /** Cached session ID for self-handshake mode. Null can mean two distinct
   *  things — either "not yet handshaked" or "handshaked against a stateless
   *  endpoint that didn't mint a session" — so this field alone can't gate
   *  re-handshake decisions. The `handshakeComplete` flag below disambiguates. */
  private cachedSessionId: string | null = null;
  /** True once a successful initialize + notifications/initialized round-trip
   *  has completed, regardless of whether the server minted a session. Lets
   *  stateless endpoints skip the handshake after the first call instead of
   *  re-running it on every invoke. Cleared on session-invalid responses. */
  private handshakeComplete = false;
  /** In-flight handshake promise. When set, concurrent first-invokes share
   *  one handshake instead of each opening their own initialize round-trip. */
  private handshakePromise: Promise<string | null> | null = null;
  private readonly clientInfo: ClientInfo;
  private readonly protocolVersion: string;

  constructor(
    private readonly manifest: HttpClientManifest,
    private readonly ctx: ResourceContext,
  ) {
    this.clientInfo = manifest.clientInfo ?? DEFAULT_CLIENT_INFO;
    this.protocolVersion = manifest.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
  }

  async init(): Promise<void> {
    // Config validation only — no network I/O. The handshake fires lazily on
    // first invoke() (self-handshake mode) or never (external provider mode).
    if (!this.manifest.url) {
      throw transportError("Mcp.HttpClient requires a `url` field");
    }
    try {
      // Validate URL shape up-front so a typo throws at boot, not on first call.
      new URL(this.manifest.url);
    } catch {
      throw transportError(`Mcp.HttpClient: invalid URL '${this.manifest.url}'`);
    }
  }

  async invoke(inputs: InvokeInput): Promise<Record<string, unknown>> {
    if (!inputs || typeof inputs.method !== "string") {
      throw protocolError("Mcp.HttpClient.invoke requires inputs.method");
    }
    if (this.manifest.sessionProvider) {
      return this.invokeExternal(inputs);
    }
    return this.invokeSelfHandshake(inputs);
  }

  private async invokeExternal(inputs: InvokeInput): Promise<Record<string, unknown>> {
    let provider: SessionProviderInstance;
    try {
      provider = this.ctx.moduleContext.getInstance(
        this.manifest.sessionProvider!,
      ) as SessionProviderInstance;
    } catch (err) {
      throw transportError(
        `Mcp.HttpClient: sessionProvider '${this.manifest.sessionProvider}' not found: ${(err as Error).message}`,
      );
    }
    if (!provider || typeof provider.provide !== "function") {
      throw transportError(
        `Mcp.HttpClient: sessionProvider '${this.manifest.sessionProvider}' did not resolve to a Mcp.SessionProvider instance (no provide())`,
      );
    }
    const { sessionId } = await provider.provide();
    if (!sessionId || typeof sessionId !== "string") {
      throw protocolError(
        `Mcp.HttpClient: sessionProvider '${this.manifest.sessionProvider}' returned no sessionId`,
      );
    }
    const { result } = await postJsonRpc(
      this.manifest.url,
      this.manifest.headers ?? {},
      sessionId,
      this.buildRequest(inputs),
    );
    return result;
  }

  private async invokeSelfHandshake(
    inputs: InvokeInput,
  ): Promise<Record<string, unknown>> {
    try {
      const sessionId = await this.ensureSession();
      const { result } = await postJsonRpc(
        this.manifest.url,
        this.manifest.headers ?? {},
        sessionId,
        this.buildRequest(inputs),
      );
      return result;
    } catch (err) {
      if (!isInvokeErrorWithCode(err, "ERR_MCP_SESSION_INVALID")) {
        throw err;
      }
      // Session-invalid: invalidate the cache, re-handshake, and retry the
      // original request once. A second rejection surfaces to the caller.
      this.cachedSessionId = null;
      this.handshakeComplete = false;
      const sessionId = await this.ensureSession();
      try {
        const { result } = await postJsonRpc(
          this.manifest.url,
          this.manifest.headers ?? {},
          sessionId,
          this.buildRequest(inputs),
        );
        return result;
      } catch (retryErr) {
        if (isInvokeErrorWithCode(retryErr, "ERR_MCP_SESSION_INVALID")) {
          throw sessionInvalidError(
            "Mcp.HttpClient: session rejected after re-handshake; giving up",
            { url: this.manifest.url },
          );
        }
        throw retryErr;
      }
    }
  }

  private async ensureSession(): Promise<string | null> {
    if (this.handshakeComplete) return this.cachedSessionId;
    if (this.handshakePromise) return this.handshakePromise;
    // Capture the in-flight handshake so concurrent first-invokes share one
    // initialize round-trip. `inflight` is held by reference so the finally
    // block can ask "is this still my handshake?" — a session-invalid retry
    // path can replace `this.handshakePromise` while we await, and only the
    // owner of the still-current slot should clear it.
    const inflight = this.runHandshake();
    this.handshakePromise = inflight;
    try {
      return await inflight;
    } finally {
      // Reference equality is intentional — both operands are the same
      // Promise handle when no concurrent reset has happened. Do NOT await.
      if (this.handshakePromise === inflight) {
        this.handshakePromise = null;
      }
    }
  }

  /** Initialize handshake — POST initialize, capture the server-minted
   *  Mcp-Session-Id (null for stateless endpoints), POST
   *  notifications/initialized. Caches the sessionId for the life of the
   *  resource until a session-invalid response forces a re-handshake. */
  private async runHandshake(): Promise<string | null> {
    const initializeReq: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "initialize",
      params: {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: this.clientInfo,
      },
    };
    const { responseSessionId } = await postJsonRpc(
      this.manifest.url,
      this.manifest.headers ?? {},
      null,
      initializeReq,
    );

    const initializedNote: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    };
    await postJsonRpc(
      this.manifest.url,
      this.manifest.headers ?? {},
      responseSessionId,
      initializedNote,
    );

    this.cachedSessionId = responseSessionId;
    this.handshakeComplete = true;
    return responseSessionId;
  }

  private buildRequest(inputs: InvokeInput): JsonRpcRequest {
    return {
      jsonrpc: "2.0",
      id: this.nextId(),
      method: inputs.method,
      params: inputs.params ?? {},
    };
  }

  snapshot(): Record<string, unknown> {
    return {
      url: this.manifest.url,
      sessionProviderName: this.manifest.sessionProvider ?? null,
      protocolVersion: this.protocolVersion,
    };
  }

  async teardown(): Promise<void> {
    // Best-effort DELETE per the Streamable HTTP spec for self-handshake
    // sessions. External-provider sessions are owned upstream and we don't
    // touch them. Errors swallowed — the kernel is shutting down.
    const sessionId = this.cachedSessionId;
    this.cachedSessionId = null;
    this.handshakeComplete = false;
    this.handshakePromise = null;
    if (this.manifest.sessionProvider || !sessionId) return;
    try {
      await fetch(this.manifest.url, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": sessionId, ...(this.manifest.headers ?? {}) },
      });
    } catch (err) {
      await this.ctx.emitEvent(`${this.manifest.metadata.name}.SessionTerminateFailed`, {
        error: { message: (err as Error).message },
      });
    }
  }
}

function isInvokeErrorWithCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === code
  );
}

export async function create(
  resource: HttpClientManifest,
  ctx: ResourceContext,
): Promise<McpHttpClient> {
  return new McpHttpClient(resource, ctx);
}
