import {
  type ControllerContext,
  type Invocable,
  type ResourceContext,
} from "@telorun/sdk";

import { protocolError, transportError } from "./errors.js";

interface ToolsListManifest {
  kind: string;
  metadata: { name: string };
  // The `client` x-telo-ref is replaced with the live Mcp.Client instance by
  // the kernel's Phase-5 injection before the controller runs.
  client: unknown;
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
    const client = this.manifest.client;
    if (!client || typeof (client as { invoke?: unknown }).invoke !== "function") {
      throw transportError(
        `${this.manifest.kind}: client did not resolve to an Mcp.Client instance (no invoke())`,
      );
    }
    return client as GenericClient;
  }
}

export async function create(
  resource: ToolsListManifest,
  ctx: ResourceContext,
): Promise<McpToolsList> {
  return new McpToolsList(resource, ctx);
}
