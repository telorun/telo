import type { InvokeContext } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";

/** The Mcp.Client contract as this module uses it: one JSON-RPC method per call. */
export interface McpClientInstance {
  invoke(
    input: { method: string; params?: Record<string, unknown> },
    ctx?: InvokeContext,
  ): Promise<unknown>;
}

/** The live Mcp.Client injected into a provider's `client` slot. */
export function liveMcpClient(client: unknown, provider: string): McpClientInstance {
  if (!client || typeof (client as McpClientInstance).invoke !== "function") {
    throw new InvokeError(
      "ERR_INVALID_REFERENCE",
      `${provider}: 'client' is not a live Mcp.Client instance — check Phase 5 injection.`,
    );
  }
  return client as McpClientInstance;
}
