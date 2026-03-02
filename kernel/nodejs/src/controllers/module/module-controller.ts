import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { Loader } from "../../loader.js";

export async function create(
  resource: any,
  ctx: ResourceContext,
): Promise<ResourceInstance> {
  const moduleName = resource.metadata.name as string;
  const loader = new Loader();

  for (const includePath of (resource.include as string[]) ?? []) {
    const manifests = await loader.loadManifest(
      includePath,
      resource.metadata.source as string,
      {},
    );
    for (const manifest of manifests) {
      if (manifest.kind === "Kernel.Module") {
        throw new Error(
          `Included file "${includePath}" must not declare kind: Module`,
        );
      }
      if (!manifest.metadata.module) {
        manifest.metadata.module = moduleName;
      }
      ctx.registerManifest(manifest);
    }
  }

  return {};
}

export const schema = {
  type: "object",
  properties: {
    kind: { type: "string" },
    metadata: {
      type: "object",
      properties: {
        name: { type: "string" },
        version: { type: "string" },
        source: { type: "string" },
        module: { type: "string" },
      },
      required: ["name"],
      additionalProperties: true,
    },
    include: { type: "array", items: { type: "string" } },
    variables: { type: "object" },
    secrets: { type: "object" },
    exports: { type: "object", additionalProperties: { type: "string" } },
  },
  required: ["metadata"],
  additionalProperties: false,
};
