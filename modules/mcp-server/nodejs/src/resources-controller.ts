import { type ControllerContext, type ResourceContext, RuntimeError } from "@telorun/sdk";

interface ResourcesManifest {
  metadata?: { name?: string };
  entries?: unknown[];
}

export async function register(_ctx: ControllerContext): Promise<void> {}

/** v2 runtime — schema-only in v1. The bundle is created so transport refs
 *  resolve cleanly, but transports refuse to wire it up: `Mcp.StdioServer` /
 *  `Mcp.HttpEndpoint` throw at init() if `resources:` is non-empty, and
 *  `resolveEntries()` throws if anyone calls it directly. */
export class McpResourcesBundle {
  constructor(
    public readonly bundleName: string,
    public readonly entries: unknown[],
  ) {}

  resolveEntries(): never {
    throw new RuntimeError(
      "ERR_MCP_V2_NOT_IMPLEMENTED",
      `Mcp.Resources[${this.bundleName}]: runtime dispatch is v2 work`,
    );
  }
}

export async function create(
  resource: ResourcesManifest,
  _ctx: ResourceContext,
): Promise<McpResourcesBundle> {
  const bundleName = resource.metadata?.name;
  if (!bundleName) {
    throw new RuntimeError(
      "ERR_MCP_RESOURCES_INVALID",
      "Mcp.Resources: metadata.name is required",
    );
  }
  return new McpResourcesBundle(bundleName, resource.entries ?? []);
}
