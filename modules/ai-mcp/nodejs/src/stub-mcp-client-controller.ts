import type { InvokeContext, ResourceInstance } from "@telorun/sdk";
import { ERR_INVOKE_CANCELLED, InvokeError } from "@telorun/sdk";

/**
 * Test-support Mcp.Client stub. Implements the Mcp.Client JSON-RPC contract with canned
 * responses so AiMcp.ToolProvider's discovery/dispatch can be tested without a live MCP
 * server. Advertises `echo_text` (echoes its `text` argument) and `snapshot_image`
 * (returns an MCP image content block, whose `mimeType` the provider normalizes to the
 * Ai contract's `mediaType`), `wait_for_cancel` (never answers; rejects when the call's
 * context is cancelled, counting it) and `cancelled_count` (how many calls were
 * cancelled so far, so a test can prove the cancellation reached the client).
 */
interface StubInvokeInput {
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

class StubMcpClient implements ResourceInstance {
  private cancelledCalls = 0;

  async invoke({ method, params }: StubInvokeInput, ctx?: InvokeContext): Promise<unknown> {
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
          {
            name: "wait_for_cancel",
            description: "Never answers; ends when the call is cancelled.",
            inputSchema: { type: "object", additionalProperties: false, properties: {} },
          },
          {
            name: "cancelled_count",
            description: "How many calls were cancelled so far.",
            inputSchema: { type: "object", additionalProperties: false, properties: {} },
          },
        ],
      };
    }
    if (method === "tools/call") {
      if (params?.name === "wait_for_cancel") {
        const token = ctx?.cancellation;
        if (!token) throw new Error("wait_for_cancel needs an invocation context to end");
        return new Promise((_, reject) => {
          // Stands for the open connection a real in-flight call holds, which is
          // what keeps the process alive while it waits.
          const inFlight = setInterval(() => undefined, 60_000);
          token.onCancelled((reason) => {
            clearInterval(inFlight);
            this.cancelledCalls++;
            reject(new InvokeError(ERR_INVOKE_CANCELLED, `wait_for_cancel cancelled (${reason})`));
          });
        });
      }
      if (params?.name === "cancelled_count") {
        return { content: [{ type: "text", text: String(this.cancelledCalls) }] };
      }
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

