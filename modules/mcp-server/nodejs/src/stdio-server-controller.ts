import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { type ControllerContext, type ResourceContext, RuntimeError } from "@telorun/sdk";

import { buildServer, type SessionContext, type ServerInfo } from "./registry.js";
import { asToolsBundle } from "./tools-controller.js";

interface StdioServerManifest {
  kind: string;
  metadata: { name: string };
  serverInfo: ServerInfo;
  instructions?: string;
  tools?: string[];
  resources?: string[];
  prompts?: string[];
}

export async function register(_ctx: ControllerContext): Promise<void> {}

export class McpStdioServer {
  private server: Server | null = null;
  private transport: StdioServerTransport | null = null;
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
        `${this.resource.kind}[${this.resource.metadata.name}]: resources/prompts are schema-only in v1; runtime dispatch is v2 work`,
      );
    }

    const toolsBundles = (this.resource.tools ?? []).map((ref) =>
      asToolsBundle(ref, `${this.resource.kind}[${this.resource.metadata.name}]`),
    );

    return this.ctx.effect("mcp server", async () => {
      const server = buildServer({
        serverInfo: this.resource.serverInfo,
        instructions: this.resource.instructions,
        toolsBundles,
        sessionResolver: () => this.session,
        ctx: this.ctx,
        moduleContext: this.ctx.moduleContext,
      });
      this.server = server;
      return {
        result: server,
        inverse: async () => {
          this.server = null;
          await server.close();
        },
      };
    });
  }

  async run() {
    if (!this.server) {
      throw new Error("Mcp.StdioServer.run() called before init()");
    }
    // Performed rather than returned, because this hold has to be releasable
    // BEFORE the resource unwinds: stdin reaching EOF is what lets the kernel
    // exit, and at that moment the server is still alive. `dispose()` is the
    // scope's own idempotent release, so the EOF path and the unwind cannot
    // release it twice.
    const hold = await this.ctx
      .effect("kernel hold", async () => ({ result: undefined, inverse: this.ctx.acquireHold() }))
      .perform();

    return this.ctx
      .effect("stdio transport", async () => {
        // ResourceContext types stdin/stdout as the structural NodeJS.ReadableStream
        // / NodeJS.WritableStream interfaces, while the MCP SDK accepts the
        // concrete node:stream `Readable` / `Writable` classes. process.stdin
        // and process.stdout satisfy both shapes; a single cast is enough here.
        const transport = new StdioServerTransport(
          this.ctx.stdin as unknown as Readable,
          this.ctx.stdout as unknown as Writable,
        );
        this.transport = transport;
        // The transport's `onclose` fires when stdin reaches EOF (the parent
        // closed the pipe), and releasing the hold then is what lets the kernel
        // exit.
        transport.onclose = () => {
          hold.dispose().catch((err: unknown) => {
            this.ctx.log.error("Releasing the kernel hold at stdin EOF failed", undefined, {
              error: err,
              eventName: "mcp.hold.release_failed",
            });
          });
        };

        await this.server!.connect(transport);
        await this.ctx.emitEvent(`${this.resource.metadata.name}.Listening`, {
          transport: "stdio",
          sessionId: this.session.id,
        });
        return {
          result: undefined,
          inverse: async () => {
            this.transport = null;
            await transport.close();
          },
        };
      });
  }

}

export async function create(
  resource: StdioServerManifest,
  ctx: ResourceContext,
): Promise<McpStdioServer> {
  return new McpStdioServer(resource, ctx);
}
