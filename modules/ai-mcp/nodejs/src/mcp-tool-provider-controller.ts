import type { AiToolProviderInstance, ToolDescriptor } from "@telorun/ai/types";
import type { ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";

/**
 * AiMcp.ToolProvider — bridges an MCP server (any Mcp.Client) to the Ai.ToolProvider
 * contract. It speaks no MCP itself beyond the two JSON-RPC methods: it forwards
 * `{ method, params }` to the injected client and reshapes the results.
 *
 *   listTools() → tools/list   → ToolDescriptor[] (inputSchema becomes `parameters`)
 *   callTool()  → tools/call   → the tool's content (the agent stringifies it)
 *
 * The agent never learns it is MCP; `modules/ai` never depends on `@telorun/mcp-client`.
 */
interface McpClientInstance {
  invoke(input: { method: string; params?: Record<string, unknown> }): Promise<unknown>;
}

interface McpToolProviderResource {
  metadata: { name: string; module?: string };
  /** Live Mcp.Client instance after Phase 5 injection. */
  client: McpClientInstance;
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
  constructor(private readonly resource: McpToolProviderResource) {}

  private client(): McpClientInstance {
    const client = this.resource.client;
    if (!client || typeof client.invoke !== "function") {
      throw new InvokeError(
        "ERR_INVALID_REFERENCE",
        `AiMcp.ToolProvider "${this.resource.metadata.name}": 'client' is not a live Mcp.Client instance — check Phase 5 injection.`,
      );
    }
    return client;
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

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = (await this.client().invoke({
      method: "tools/call",
      params: { name, arguments: args },
    })) as McpToolCallResult;
    if (result?.isError) {
      throw new InvokeError(
        "ERR_MCP_TOOL_ERROR",
        `AiMcp.ToolProvider "${this.resource.metadata.name}": MCP tool "${name}" returned an error.`,
      );
    }
    return result?.structuredContent ?? result?.content ?? result;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: McpToolProviderResource): Promise<McpToolProvider> {
  return new McpToolProvider(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
