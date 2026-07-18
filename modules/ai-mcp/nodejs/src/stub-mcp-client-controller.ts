import type { ResourceInstance } from "@telorun/sdk";

/**
 * Test-support Mcp.Client stub. Implements the Mcp.Client JSON-RPC contract with canned
 * responses so AiMcp.ToolProvider's discovery/dispatch can be tested without a live MCP
 * server. Advertises `echo_text` (echoes its `text` argument) and `snapshot_image`
 * (returns an MCP image content block, whose `mimeType` the provider normalizes to the
 * Ai contract's `mediaType`).
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
          {
            name: "snapshot_image",
            description: "Return a canned image.",
            inputSchema: { type: "object", additionalProperties: false, properties: {} },
          },
        ],
      };
    }
    if (method === "tools/call") {
      if (params?.name === "snapshot_image") {
        return { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] };
      }
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

