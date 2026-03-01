import { Static, Type } from "@sinclair/typebox";
import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { Loader } from "../../loader.js";

type ModuleResource = Static<typeof schema>;

export async function create(
  resource: ModuleResource,
  ctx: ResourceContext,
): Promise<ResourceInstance> {
  const loader = new Loader();
  try {
    // Load and register resource definitions from imports
    if (resource.imports && Array.isArray(resource.imports)) {
      for (const importPath of resource.imports) {
        const defResources = await loader.loadManifest(importPath, resource.metadata.source);
        for (const defResource of defResources) {
          ctx.registerManifest(defResource);
        }
      }
    }

    return {};
  } catch (error) {
    throw new Error(
      `Failed to process Module "${resource.metadata.name}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const schema = Type.Object(
  {
    kind: Type.String(),
    metadata: Type.Record(Type.String(), Type.Any()),
    source: Type.Optional(Type.String()),
    imports: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);
