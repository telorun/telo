import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { type ControllerContext, type ResourceContext, RuntimeError } from "@telorun/sdk";

import { buildServer, type SessionContext, type ServerInfo } from "./registry.js";
import type { McpToolsBundle } from "./tools-controller.js";

interface StdioServerManifest {
  metadata: { name: string };
  serverInfo: ServerInfo;
  tools?: string[];
  resources?: string[];
  prompts?: string[];
}

export async function register(_ctx: ControllerContext): Promise<void> {}

export class McpStdioServer {
  private server: Server | null = null;
  private transport: StdioServerTransport | null = null;
  private releaseHold: (() => void) | null = null;
  private session: SessionContext;

  constructor(
    private readonly resource: StdioServerManifest,
    private readonly ctx: ResourceContext,
  ) {
    // stdio has no transport-level session id; mint a stable synthetic UUID at
    // construction so request.session.id is always defined for CEL inputs.
    this.session = { id: randomUUID(), clientInfo: {}, capabilities: {} };
  }

  async init() {
    if ((this.resource.resources ?? []).length > 0 || (this.resource.prompts ?? []).length > 0) {
      throw new RuntimeError(
        "ERR_MCP_V2_NOT_IMPLEMENTED",
        `Mcp.StdioServer[${this.resource.metadata.name}]: resources/prompts are schema-only in v1; runtime dispatch is v2 work`,
      );
    }

    const toolsBundles = (this.resource.tools ?? []).map((bundleName) => {
      const inst = this.ctx.moduleContext.getInstance(bundleName) as McpToolsBundle | undefined;
      if (!inst) {
        throw new RuntimeError(
          "ERR_MCP_BUNDLE_NOT_FOUND",
          `Mcp.StdioServer[${this.resource.metadata.name}]: tools bundle '${bundleName}' not found in module scope`,
        );
      }
      return inst;
    });

    this.server = buildServer({
      serverInfo: this.resource.serverInfo,
      toolsBundles,
      sessionResolver: () => this.session,
      ctx: this.ctx,
      moduleContext: this.ctx.moduleContext,
    });
  }

  async run(): Promise<void> {
    if (!this.server) {
      throw new Error("Mcp.StdioServer.run() called before init()");
    }

    this.releaseHold = this.ctx.acquireHold();
    try {
      // ResourceContext types stdin/stdout as the structural NodeJS.ReadableStream
      // / NodeJS.WritableStream interfaces, while the MCP SDK accepts the
      // concrete node:stream `Readable` / `Writable` classes. process.stdin
      // and process.stdout satisfy both shapes; a single cast is enough here.
      this.transport = new StdioServerTransport(
        this.ctx.stdin as unknown as Readable,
        this.ctx.stdout as unknown as Writable,
      );

      // The transport's `onclose` fires when stdin reaches EOF (the parent
      // closed the pipe). Releasing the hold then lets the kernel exit.
      this.transport.onclose = () => {
        if (this.releaseHold) {
          this.releaseHold();
          this.releaseHold = null;
        }
      };

      await this.server.connect(this.transport);

      await this.ctx.emitEvent(`${this.resource.metadata.name}.Listening`, {
        transport: "stdio",
        sessionId: this.session.id,
      });
    } catch (error) {
      if (this.releaseHold) {
        this.releaseHold();
        this.releaseHold = null;
      }
      throw error;
    }
  }

  async teardown(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    if (this.server) {
      await this.server.close();
      this.server = null;
    }
    if (this.releaseHold) {
      this.releaseHold();
      this.releaseHold = null;
    }
  }
}

export async function create(
  resource: StdioServerManifest,
  ctx: ResourceContext,
): Promise<McpStdioServer> {
  return new McpStdioServer(resource, ctx);
}
