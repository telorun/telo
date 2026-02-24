import type { ResourceContext, ResourceInstance } from "@telorun/sdk";

type CapabilityResource = {
  kind: string;
  metadata: {
    name: string;
    [key: string]: any;
  };
  schema?: Record<string, any>;
};

class Capability implements ResourceInstance {
  constructor(private readonly resource: CapabilityResource) {}

  async init(ctx: ResourceContext) {
    ctx.registerCapability(this.resource.metadata.name, this.resource.schema);
  }
}

export async function create(resource: any, _ctx: ResourceContext): Promise<Capability> {
  return new Capability(resource as CapabilityResource);
}

export const schema = {
  type: "object",
  properties: {
    metadata: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
    schema: {
      type: "object",
      additionalProperties: true,
    },
  },
  required: ["metadata"],
  additionalProperties: true,
};
