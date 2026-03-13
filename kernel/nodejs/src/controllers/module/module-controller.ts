import type { ResourceContext, ResourceInstance } from "@telorun/sdk";

export async function create(resource: any, ctx: ResourceContext): Promise<ResourceInstance> {
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
    lifecycle: {
      type: "string",
      enum: ["shared", "isolated"],
      default: "shared",
      description:
        "Whether the module should be loaded in a shared context (default) or an isolated context",
    },
    keepAlive: {
      type: "boolean",
      default: false,
      description:
        "Whether the module should keep running after all its imports are removed. Only applicable for shared lifecycle.",
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
