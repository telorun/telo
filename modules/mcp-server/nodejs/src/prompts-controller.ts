import { type ControllerContext, type ResourceContext, RuntimeError } from "@telorun/sdk";

interface PromptsManifest {
  metadata?: { name?: string };
  entries?: unknown[];
}

export async function register(_ctx: ControllerContext): Promise<void> {}

/** v2 runtime — schema-only in v1. See resources-controller.ts for the same
 *  pattern. */
export class McpPromptsBundle {
  constructor(
    public readonly bundleName: string,
    public readonly entries: unknown[],
  ) {}

  resolveEntries(): never {
    throw new RuntimeError(
      "ERR_MCP_V2_NOT_IMPLEMENTED",
      `Mcp.Prompts[${this.bundleName}]: runtime dispatch is v2 work`,
    );
  }
}

export async function create(
  resource: PromptsManifest,
  _ctx: ResourceContext,
): Promise<McpPromptsBundle> {
  const bundleName = resource.metadata?.name;
  if (!bundleName) {
    throw new RuntimeError(
      "ERR_MCP_PROMPTS_INVALID",
      "Mcp.Prompts: metadata.name is required",
    );
  }
  return new McpPromptsBundle(bundleName, resource.entries ?? []);
}
