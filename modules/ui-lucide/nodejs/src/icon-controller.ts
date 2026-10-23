import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import { fileURLToPath } from "node:url";

/**
 * One Lucide glyph: the SVG file of the name it was declared with, which the
 * module ships. The schema's closed enum is the staged glyph set, so a name
 * that reaches here names a file.
 */
export async function create(resource: RuntimeResource & { name: string }, ctx: ResourceContext): Promise<ResourceInstance> {
  return {
    provide: async () => ({ file: fileURLToPath(await ctx.resolveControllerFile(`./icons/${resource.name}.svg`)) }),
  };
}
