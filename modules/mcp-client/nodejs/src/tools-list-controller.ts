import {
  type ControllerContext,
  type Invocable,
  type ResourceContext,
} from "@telorun/sdk";

import { protocolError, transportError } from "./errors.js";

interface ToolsListManifest {
  metadata: { name: string };
  client: string;
}

interface ToolEntry {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface ToolsListResult {
  tools: ToolEntry[];
}

type GenericClient = Invocable<
  { method: string; params?: Record<string, unknown> },
  Record<string, unknown>
>;

export async function register(_ctx: ControllerContext): Promise<void> {}

export class McpToolsList {
  constructor(
    private readonly manifest: ToolsListManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(_inputs: Record<string, never>): Promise<ToolsListResult> {
    const client = this.resolveClient();
    const raw = await client.invoke({ method: "tools/list", params: {} });
    if (!Array.isArray(raw.tools)) {
      throw protocolError(
        "Mcp.ToolsList: server response missing or malformed tools array",
        { result: raw },
      );
    }
    return { tools: raw.tools as ToolEntry[] };
  }

  private resolveClient(): GenericClient {
    let resolved: unknown;
    try {
      resolved = this.ctx.moduleContext.getInstance(this.manifest.client);
    } catch (err) {
      throw transportError(
        `Mcp.ToolsList: client '${this.manifest.client}' not found: ${(err as Error).message}`,
      );
    }
    if (
      !resolved ||
      typeof (resolved as { invoke?: unknown }).invoke !== "function"
    ) {
      throw transportError(
        `Mcp.ToolsList: client '${this.manifest.client}' did not resolve to an Mcp.Client (no invoke())`,
      );
    }
    return resolved as GenericClient;
  }
}

export async function create(
  resource: ToolsListManifest,
  ctx: ResourceContext,
): Promise<McpToolsList> {
  return new McpToolsList(resource, ctx);
}
