import type {
  ControllerContext,
  ResourceContext,
  ResourceInstance,
  RuntimeResource,
} from "@telorun/sdk";
import { ControllerLoader } from "../../controller-loader.js";
import { formatAjvErrors, validateResourceDefinition } from "../../manifest-schemas.js";

type ResourceDefinitionResource = RuntimeResource & {
  kind: "Definition";
  metadata: {
    [key: string]: any;
    name: string;
    module?: string;
  };
  schema: Record<string, any>;
  capabilities: string[];
  events?: string[];
  controllers: Array<string>;
};

/**
 * ResourceDefinition resource - acts as metadata holder for resource type definitions
 * Validates incoming definitions against schema and maintains definition metadata
 */
class ResourceDefinition implements ResourceInstance {
  readonly kind: "ResourceDefinition" = "ResourceDefinition";

  constructor(
    readonly resource: ResourceDefinitionResource,
    private controllerLoader: ControllerLoader,
  ) {}

  async init(ctx: ResourceContext) {
    for (const cap of this.resource.capabilities) {
      if (!ctx.isCapabilityRegistered(cap)) {
        throw new Error(
          `Capability "${cap}" is not registered. Declare it as a Runtime.Capability resource.`,
        );
      }
      const capSchema = ctx.getCapabilitySchema(cap);
      if (capSchema) {
        ctx.validateSchema(this.resource, capSchema);
      }
    }

    const controllerInstance = await this.controllerLoader.load(
      this.resource.controllers,
      this.resource.metadata.source,
    );
    ctx.registerDefinition(this.resource);
    await ctx.registerController(
      this.resource.metadata.module,
      this.resource.metadata.name,
      controllerInstance,
    );
  }
}

export function register(ctx: ControllerContext): void {
  // ResourceDefinition is a passive resource - no registration needed
}

export async function create(resource: any, ctx: ResourceContext): Promise<ResourceDefinition> {
  // Validate incoming resource definition against schema
  if (!validateResourceDefinition(resource)) {
    throw new Error(
      `Invalid ResourceDefinition "${resource.metadata.name}": ${formatAjvErrors(validateResourceDefinition.errors)}`,
    );
  }

  // Return a fully-formed ResourceDefinition instance
  const definition = resource as ResourceDefinitionResource;
  return new ResourceDefinition(definition, new ControllerLoader());
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
