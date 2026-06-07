import { randomUUID } from "node:crypto";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { type ControllerContext, type ResourceContext, RuntimeError } from "@telorun/sdk";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { buildServer, type SessionContext, type ServerInfo } from "./registry.js";
import { asToolsBundle, type McpToolsBundle } from "./tools-controller.js";

interface HttpEndpointManifest {
  kind: string;
  metadata: { name: string };
  serverInfo: ServerInfo;
  instructions?: string;
  /** When true, mint an `Mcp-Session-Id` on initialize and route follow-up
   *  requests to the same in-memory SDK Server. When false (default), every
   *  request is independent — required for horizontally scaled deployments
   *  without sticky session affinity. */
  stateful?: boolean;
  tools?: string[];
  resources?: string[];
  prompts?: string[];
}

interface SessionRecord {
  server: Server;
  transport: StreamableHTTPServerTransport;
  context: SessionContext;
}

export async function register(_ctx: ControllerContext): Promise<void> {}

export class McpHttpEndpoint {
  private readonly sessions = new Map<string, SessionRecord>();
  private toolsBundles: McpToolsBundle[] = [];

  constructor(
    private readonly resource: HttpEndpointManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async init() {
    if ((this.resource.resources ?? []).length > 0 || (this.resource.prompts ?? []).length > 0) {
      throw new RuntimeError(
        "ERR_MCP_V2_NOT_IMPLEMENTED",
        `${this.resource.kind}[${this.resource.metadata.name}]: resources/prompts are schema-only in v1; runtime dispatch is v2 work`,
      );
    }
    this.toolsBundles = (this.resource.tools ?? []).map((ref) =>
      asToolsBundle(ref, `${this.resource.kind}[${this.resource.metadata.name}]`),
    );
  }

  /** Mount contract — duck-typed against Http.Server's mount loop. The
   *  signature matches Http.Api.register(); see plan §3 mount contract.
   *
   *  Routes are declared with `app.route(...)` directly rather than via
   *  `app.register(plugin, { prefix })`. The latter is async (the plugin
   *  loads inside `app.ready()`); declaring the route synchronously removes
   *  any ordering coupling with the host's `app.listen()` call. Both
   *  `<prefix>` and `<prefix>/` are registered so trailing-slash variants
   *  both reach the handler. */
  register(app: FastifyInstance, prefix = "") {
    const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      await this.handleRequest(request, reply);
    };
    const methods = ["POST", "GET", "DELETE"];

    // Normalize prefix: strip a trailing slash unless the prefix is exactly
    // "/", so a configured `/mcp/` doesn't expand to `/mcp//`.
    const base =
      prefix && prefix !== "/" && prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;

    if (base && base !== "/") {
      app.route({ method: methods, url: base, handler });
      app.route({ method: methods, url: `${base}/`, handler });
    } else {
      app.route({ method: methods, url: "/", handler });
    }

    app.addHook("onClose", async () => {
      await this.closeAllSessions();
    });
  }

  private async handleRequest(request: FastifyRequest, reply: FastifyReply) {
    const body = request.body as Record<string, unknown> | undefined;

    if (!this.resource.stateful) {
      // Stateless: every request gets a fresh server+transport pair. The
      // SDK's stateless transport (`sessionIdGenerator: undefined`) does not
      // mint or validate `Mcp-Session-Id` — any header the client sends is
      // ignored. Required for horizontally scaled deploys without sticky
      // affinity at the LB.
      const record = await this.createSession({ stateful: false });
      reply.hijack();
      try {
        await record.transport.handleRequest(request.raw, reply.raw, body);
      } finally {
        await this.closeRecord(record);
      }
      return;
    }

    const sessionHeader = (request.headers["mcp-session-id"] ?? "") as string;

    let record: SessionRecord | undefined;
    if (sessionHeader) {
      record = this.sessions.get(sessionHeader);
      if (!record) {
        reply.code(404);
        reply.header("Content-Type", "application/json");
        reply.send({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Mcp: unknown session" },
          id: null,
        });
        return;
      }
    } else if (request.method === "POST" && body && isInitializeRequest(body)) {
      record = await this.createSession({ stateful: true });
    } else {
      reply.code(400);
      reply.header("Content-Type", "application/json");
      reply.send({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Mcp: missing Mcp-Session-Id header (or initialize request body)",
        },
        id: null,
      });
      return;
    }

    // Hand the raw request/response off to the SDK transport. Fastify has
    // already parsed the body, so we pass it explicitly — the transport will
    // not re-read the stream.
    reply.hijack();
    await record.transport.handleRequest(request.raw, reply.raw, body);
  }

  private async createSession({ stateful }: { stateful: boolean }): Promise<SessionRecord> {
    const sessionContext: SessionContext = { id: "", clientInfo: {}, capabilities: {} };

    // Pre-allocate the SessionRecord shell so the onsessioninitialized
    // closure can capture a stable object reference and register the session
    // synchronously, before the transport writes the initialize response.
    // Registering after `await transport.handleRequest()` would open a race
    // where the client's follow-up request races with the registration.
    const record = { context: sessionContext } as SessionRecord;

    const transport = new StreamableHTTPServerTransport(
      stateful
        ? {
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string) => {
              sessionContext.id = id;
              this.sessions.set(id, record);
            },
          }
        : { sessionIdGenerator: undefined },
    );
    record.transport = transport;

    record.server = buildServer({
      serverInfo: this.resource.serverInfo,
      instructions: this.resource.instructions,
      toolsBundles: this.toolsBundles,
      sessionResolver: () => sessionContext,
      ctx: this.ctx,
      moduleContext: this.ctx.moduleContext,
    });

    if (stateful) {
      transport.onclose = () => {
        if (sessionContext.id) {
          this.sessions.delete(sessionContext.id);
        }
      };
    }

    await record.server.connect(transport);
    return record;
  }

  private async closeRecord(record: SessionRecord): Promise<void> {
    const sessionId = record.context.id || "<unbound>";
    try {
      await record.transport.close();
    } catch (err) {
      await this.ctx.emitEvent(`${this.resource.metadata.name}.SessionCloseFailed`, {
        sessionId,
        stage: "transport",
        error: errorPayload(err),
      });
    }
    try {
      await record.server.close();
    } catch (err) {
      await this.ctx.emitEvent(`${this.resource.metadata.name}.SessionCloseFailed`, {
        sessionId,
        stage: "server",
        error: errorPayload(err),
      });
    }
  }

  private async closeAllSessions(): Promise<void> {
    const records = Array.from(this.sessions.values());
    this.sessions.clear();
    for (const record of records) {
      await this.closeRecord(record);
    }
  }
}

function errorPayload(err: unknown): { message: string; stack?: string; code?: string } {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack, code: (err as { code?: string }).code };
  }
  return { message: String(err) };
}

export async function create(
  resource: HttpEndpointManifest,
  ctx: ResourceContext,
): Promise<McpHttpEndpoint> {
  return new McpHttpEndpoint(resource, ctx);
}
