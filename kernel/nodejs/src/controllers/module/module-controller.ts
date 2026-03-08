import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { Loader } from "../../loader.js";

export async function create(resource: any, ctx: ResourceContext): Promise<ResourceInstance> {
  const moduleName = resource.metadata.name as string;
  const loader = new Loader();

  // Declare this module so the registry can distinguish "not yet populated"
  // (valid during multi-pass init) from a completely unknown module name
  // (which would otherwise surface only as a cryptic CEL error at runtime).
  (ctx as any).declareModule(moduleName);

  for (const includePath of (resource.include as string[]) ?? []) {
    const manifests = await loader.loadManifest(
      includePath,
      resource.metadata.source as string,
      {},
    );
    for (const manifest of manifests) {
      if (manifest.kind === "Kernel.Module") {
        throw new Error(`Included file "${includePath}" must not declare kind: Module`);
      }
      if (!manifest.metadata.module) {
        manifest.metadata.module = moduleName;
      }
      ctx.registerManifest(manifest);
    }
  }

  return {
    run: async () => {
      for (const target of (resource.targets as string[]) ?? []) {
        const [kind, name] = target.split(".");
        if (!kind || !name) {
          throw new Error(`Invalid target format: "${target}". Expected "Kind.Name"`);
        }
        await ctx.invoke(kind, name, {});
      }
    },
  };
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
    targets: { type: "array", items: { type: "string" } },
    exports: {
      type: "object",
      properties: {
        kinds: { type: "array", items: { type: "string" } },
      },
      additionalProperties: true,
    },
  },
  required: ["metadata"],
  additionalProperties: false,
};
