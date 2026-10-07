import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import type { Provided } from "./composite.js";
import { resolveNode, type AuthoredNode } from "./node-resolution.js";

type ViewResource = RuntimeResource & { content: AuthoredNode };

/** One node tree, provided resolved. */
class View implements ResourceInstance {
  constructor(
    private readonly resource: ViewResource,
    private readonly ctx: ResourceContext,
  ) {}

  async provide(): Promise<Provided> {
    const name = this.resource.metadata.name;
    const resolved = await resolveNode(this.resource.content, this.ctx, `Ui.View '${name}' content`);
    return resolved ?? { assets: [] };
  }
}

export async function create(resource: ViewResource, ctx: ResourceContext): Promise<ResourceInstance> {
  return new View(resource, ctx);
}
