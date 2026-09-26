import {
  fetchOrThrow,
  isCancellationError,
  type CancellationToken,
  type ControllerContext,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";

import {
  cancelledError,
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
  kind: string;
  metadata: { name: string };
  url: string;
  headers?: Record<string, string>;
  sessionProvider?: unknown;
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
 * Http.Server: app.close() waits for in-flight responses to drain before it
 * unblocks, but the SSE GET can only close once this client's own session
 * effect unwinds — and that won't happen until the surrounding `with:` scope
 * (which owns Http.Server) tears down. Hand-rolling means one fetch per RPC
 * and no persistent connections, so unwinding is deterministic.
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
  /** Mode discriminator (external vs self-handshake): whether a
   *  `sessionProvider` was configured at all. Captured as a plain presence
   *  check so it stays correct whether the slot still holds the unresolved ref
   *  or Phase 5 has already swapped in the live instance — deriving the mode
   *  from `sessionProviderName` would silently misroute if that name ever came
   *  back null for a configured provider. */
  private readonly hasSessionProvider: boolean;
  /** Best-effort provider name for `snapshot()`, read from the unresolved ref
   *  at construction — before Phase 5 replaces it with the live instance. */
  private readonly sessionProviderName: string | null;

  constructor(
    private readonly manifest: HttpClientManifest,
    private readonly ctx: ResourceContext,
  ) {
    this.clientInfo = manifest.clientInfo ?? DEFAULT_CLIENT_INFO;
    this.protocolVersion = manifest.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    // Capture provider presence + best-effort name from the unresolved ref now —
    // Phase 5 replaces `sessionProvider` with the live instance before the
    // controller runs.
    const sp = manifest.sessionProvider;
    this.hasSessionProvider = sp != null;
    this.sessionProviderName =
      typeof sp === "string"
        ? sp
        : ((sp as { name?: unknown } | null | undefined)?.name as string | undefined) ?? null;
  }

  init(ctx: ResourceContext) {
    // Config validation only — no network I/O. The handshake fires lazily on
    // first invoke() (self-handshake mode) or never (external provider mode) —
    // so the session it may open is what this effect's inverse terminates.
    if (!this.manifest.url) {
      throw transportError("Mcp.HttpClient requires a `url` field");
    }
    try {
      // Validate URL shape up-front so a typo throws at boot, not on first call.
      new URL(this.manifest.url);
    } catch {
      throw transportError(`Mcp.HttpClient: invalid URL '${this.manifest.url}'`);
    }
    return ctx.effect("mcp session", async () => ({
      result: undefined,
      inverse: () => this.terminateSession(),
    }));
  }

  /** A cancelled invocation aborts its request, sends the server
   *  `notifications/cancelled` for it, and rejects with `ERR_INVOKE_CANCELLED`. */
  async invoke(
    inputs: InvokeInput,
    invokeCtx?: InvokeContext,
  ): Promise<Record<string, unknown>> {
    if (!inputs || typeof inputs.method !== "string") {
      throw protocolError("Mcp.HttpClient.invoke requires inputs.method");
    }
    const token = invokeCtx?.cancellation;
    if (token?.isCancelled) throw cancelledError(this.describe(inputs), token);
    if (this.hasSessionProvider) {
      return this.invokeExternal(inputs, token);
    }
    return this.invokeSelfHandshake(inputs, token);
  }

  private async invokeExternal(
    inputs: InvokeInput,
    token: CancellationToken | undefined,
  ): Promise<Record<string, unknown>> {
    // The `sessionProvider` x-telo-ref is replaced with the live instance by
    // Phase-5 injection before the controller runs.
    const provider = this.manifest.sessionProvider as SessionProviderInstance | undefined;
    if (!provider || typeof provider.provide !== "function") {
      throw transportError(
        `${this.manifest.kind}: sessionProvider did not resolve to a Mcp.SessionProvider instance (no provide())`,
      );
    }
    const { sessionId } = await provider.provide();
    if (!sessionId || typeof sessionId !== "string") {
      throw protocolError(
        `${this.manifest.kind}: sessionProvider returned no sessionId`,
      );
    }
    return this.request(sessionId, inputs, token);
  }

  private async invokeSelfHandshake(
    inputs: InvokeInput,
    token: CancellationToken | undefined,
  ): Promise<Record<string, unknown>> {
    try {
      const sessionId = await this.untilCancelled(this.ensureSession(), inputs, token);
      return await this.request(sessionId, inputs, token);
    } catch (err) {
      if (!isInvokeErrorWithCode(err, "ERR_MCP_SESSION_INVALID")) {
        throw err;
      }
      // Session-invalid: invalidate the cache, re-handshake, and retry the
      // original request once. A second rejection surfaces to the caller.
      this.cachedSessionId = null;
      this.handshakeComplete = false;
      const sessionId = await this.untilCancelled(this.ensureSession(), inputs, token);
      try {
        return await this.request(sessionId, inputs, token);
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

  /** POST one request under `token`. A cancellation that aborts the POST in
   *  flight tells the server with `notifications/cancelled`, as the Streamable
   *  HTTP transport requires: a dropped connection alone does not cancel. */
  private async request(
    sessionId: string | null,
    inputs: InvokeInput,
    token: CancellationToken | undefined,
  ): Promise<Record<string, unknown>> {
    if (token?.isCancelled) throw cancelledError(this.describe(inputs), token);
    const request = this.buildRequest(inputs);
    try {
      const { result } = await postJsonRpc(
        this.manifest.url,
        this.manifest.headers ?? {},
        sessionId,
        request,
        token,
      );
      return result;
    } catch (err) {
      if (isCancellationError(err)) this.notifyCancelled(sessionId, request.id, token?.reason);
      throw err;
    }
  }

  private notifyCancelled(sessionId: string | null, requestId: number, reason: string | undefined) {
    const note: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId, ...(reason !== undefined ? { reason } : {}) },
    };
    postJsonRpc(this.manifest.url, this.manifest.headers ?? {}, sessionId, note).catch(
      (err: unknown) => {
        this.ctx.log.warn(
          "Could not tell the MCP server a request was cancelled",
          { "mcp.transport": "http", "mcp.request.id": requestId },
          { error: err, eventName: "mcp.cancel.failed" },
        );
      },
    );
  }

  /** Wait for a shared step (the handshake) unless this invocation is cancelled
   *  first; the step itself runs on for the callers still waiting on it. */
  private untilCancelled<T>(
    pending: Promise<T>,
    inputs: InvokeInput,
    token: CancellationToken | undefined,
  ): Promise<T> {
    if (!token) return pending;
    return new Promise<T>((resolve, reject) => {
      let abandoned = false;
      const unsubscribe = token.onCancelled(() => {
        abandoned = true;
        reject(cancelledError(this.describe(inputs), token));
      });
      pending.then(
        (value) => {
          unsubscribe();
          resolve(value);
        },
        (err: unknown) => {
          unsubscribe();
          if (!abandoned) {
            reject(err);
            return;
          }
          this.ctx.log.warn(
            "MCP handshake failed after the invocation waiting on it was cancelled",
            { "mcp.transport": "http" },
            { error: err, eventName: "mcp.handshake.failed" },
          );
        },
      );
    });
  }

  private describe(inputs: InvokeInput): string {
    return `Mcp.HttpClient[${this.manifest.metadata.name}] ${inputs.method}`;
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
      sessionProviderName: this.sessionProviderName,
      protocolVersion: this.protocolVersion,
    };
  }

  private async terminateSession(): Promise<void> {
    // Best-effort DELETE per the Streamable HTTP spec for self-handshake
    // sessions. External-provider sessions are owned upstream and we don't
    // touch them. Errors swallowed — the kernel is shutting down.
    const sessionId = this.cachedSessionId;
    this.cachedSessionId = null;
    this.handshakeComplete = false;
    this.handshakePromise = null;
    if (this.hasSessionProvider || !sessionId) return;
    try {
      await fetchOrThrow(
        this.manifest.url,
        {
          method: "DELETE",
          headers: { "Mcp-Session-Id": sessionId, ...(this.manifest.headers ?? {}) },
        },
        {
          operation: "MCP session terminate",
          resource: this.manifest.metadata.name,
          setting: "url",
        },
      );
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
