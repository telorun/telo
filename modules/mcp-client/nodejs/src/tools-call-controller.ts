import {
  type ControllerContext,
  type Invocable,
  type ResourceContext,
} from "@telorun/sdk";

import { protocolError, toolError, transportError } from "./errors.js";

interface ToolsCallManifest {
  kind: string;
  metadata: { name: string };
  // The `client` x-telo-ref is replaced with the live Mcp.Client instance by
  // the kernel's Phase-5 injection before the controller runs.
  client: unknown;
}

interface ToolsCallInput {
  name: string;
  arguments?: Record<string, unknown>;
}

interface ToolsCallResult {
  content: unknown[];
  structuredContent?: Record<string, unknown>;
}

type GenericClient = Invocable<
  { method: string; params?: Record<string, unknown> },
  Record<string, unknown>
>;

export async function register(_ctx: ControllerContext): Promise<void> {}

export class McpToolsCall {
  constructor(
    private readonly manifest: ToolsCallManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: ToolsCallInput): Promise<ToolsCallResult> {
    if (!inputs || typeof inputs.name !== "string") {
      throw protocolError("Mcp.ToolsCall requires inputs.name");
    }
    const client = this.resolveClient();
    const raw = await client.invoke({
      method: "tools/call",
      params: { name: inputs.name, arguments: inputs.arguments ?? {} },
    });

    // Soft-failure conversion per §4 of the implementation plan: the MCP
    // server returns isError: true on the success channel for a tool-level
    // failure (LLM-readable content). We throw ERR_MCP_TOOL_ERROR so the
    // success path of Mcp.ToolsCall never observes isError.
    if (raw.isError === true) {
      throw toolError(raw.content);
    }
    if (!Array.isArray(raw.content)) {
      throw protocolError(
        "Mcp.ToolsCall: server response missing or malformed content array",
        { result: raw },
      );
    }
    const out: ToolsCallResult = { content: raw.content };
    if (raw.structuredContent !== undefined) {
      out.structuredContent = raw.structuredContent as Record<string, unknown>;
    }
    return out;
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
  resource: ToolsCallManifest,
  ctx: ResourceContext,
): Promise<McpToolsCall> {
  return new McpToolsCall(resource, ctx);
}
