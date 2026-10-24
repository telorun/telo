import type { AiToolProviderInstance, ToolDescriptor } from "@telorun/ai";
import type { InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import { liveMcpClient, type McpClientInstance } from "./mcp-client-instance.js";
import { mcpErrorText, normalizeMcpContent } from "./mcp-content.js";
import { untilTurnCancelled } from "./turn-cancellation.js";

/**
 * AiMcp.ToolProvider — bridges an MCP server (any Mcp.Client) to the Ai.ToolProvider
 * contract. It speaks no MCP itself beyond the two JSON-RPC methods: it forwards
 * `{ method, params }` to the injected client and reshapes the results.
 *
 *   listTools() → tools/list   → ToolDescriptor[] (inputSchema becomes `parameters`)
 *   callTool()  → tools/call   → the tool's content (the agent stringifies it)
 *
 * A `tools/call` runs under the agent turn's context: it is handed to the client, so
 * a client that honours cancellation aborts the request, and the call is abandoned
 * the moment that turn is cancelled whether or not the client does.
 *
 * The agent never learns it is MCP; `modules/ai` never depends on `@telorun/mcp-client`.
 */
interface McpToolProviderResource {
  metadata: { name: string; module?: string };
  /** Live Mcp.Client instance after Phase 5 injection. */
  client: unknown;
}

interface McpToolListResult {
  tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
}

interface McpToolCallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

class McpToolProvider implements ResourceInstance, AiToolProviderInstance {
  constructor(
    private readonly resource: McpToolProviderResource,
    private readonly ctx: ResourceContext,
  ) {}

  private client(): McpClientInstance {
    return liveMcpClient(this.resource.client, `AiMcp.ToolProvider "${this.resource.metadata.name}"`);
  }

  async listTools(): Promise<ToolDescriptor[]> {
    const result = (await this.client().invoke({
      method: "tools/list",
      params: {},
    })) as McpToolListResult;
    return (result?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      // The MCP per-tool inputSchema is statically opaque — only the server knows it.
      parameters: t.inputSchema ?? { type: "object", additionalProperties: true },
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    invokeCtx?: InvokeContext,
  ): Promise<unknown> {
    const call = this.client().invoke(
      { method: "tools/call", params: { name, arguments: args } },
      invokeCtx,
    );
    const result = (await untilTurnCancelled(call, invokeCtx, {
      subject: `AiMcp.ToolProvider "${this.resource.metadata.name}": MCP tool "${name}"`,
      log: this.ctx.log,
      lateFailure: "AiMcp.ToolProvider's cancelled MCP tool call failed after it was abandoned",
      attributes: { "mcp.tool.name": name },
    })) as McpToolCallResult;
    if (result?.isError) {
      const said = mcpErrorText(result.structuredContent ?? result.content);
      throw new InvokeError(
        "ERR_MCP_TOOL_ERROR",
        `AiMcp.ToolProvider "${this.resource.metadata.name}": MCP tool "${name}" returned an error` +
          (said ? `: ${said}` : "."),
        { content: result.content, structuredContent: result.structuredContent },
      );
    }
    if (result?.structuredContent !== undefined) return result.structuredContent;
    if (result?.content !== undefined) return normalizeMcpContent(result.content);
    return result;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: McpToolProviderResource,
  ctx: ResourceContext,
): Promise<McpToolProvider> {
  return new McpToolProvider(resource, ctx);
}

