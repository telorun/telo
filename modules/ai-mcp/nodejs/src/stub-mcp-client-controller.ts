import type { ResourceInstance } from "@telorun/sdk";

/**
 * Test-support Mcp.Client stub. Implements the Mcp.Client JSON-RPC contract with canned
 * responses so AiMcp.ToolProvider's discovery/dispatch can be tested without a live MCP
 * server. Advertises one tool (`echo_text`) and echoes its `text` argument.
 */
interface StubInvokeInput {
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

class StubMcpClient implements ResourceInstance {
  async invoke({ method, params }: StubInvokeInput): Promise<unknown> {
    if (method === "tools/list") {
      return {
        tools: [
          {
            name: "echo_text",
            description: "Echo the provided text.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["text"],
              properties: { text: { type: "string" } },
            },
          },
        ],
      };
    }
    if (method === "tools/call") {
      const text = (params?.arguments?.text as string) ?? "";
      return { content: [{ type: "text", text: `echoed: ${text}` }] };
    }
    return {};
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(): Promise<StubMcpClient> {
  return new StubMcpClient();
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
