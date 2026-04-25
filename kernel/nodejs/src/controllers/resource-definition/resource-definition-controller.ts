import type {
  ControllerContext,
  ResourceContext,
  ResourceInstance,
  RuntimeResource,
} from "@telorun/sdk";
import { ControllerLoader } from "../../controller-loader.js";
import { formatAjvErrors, validateResourceDefinition } from "../../manifest-schemas.js";
import { createTemplateController } from "./resource-template-controller.js";

type ResourceDefinitionResource = RuntimeResource & {
  kind: "Telo.Definition";
  metadata: {
    [key: string]: any;
    name: string;
    module?: string;
  };
  schema: Record<string, any>;
  capability?: string;
  controllers?: Array<string>;
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
    if (!this.resource.controllers?.length) {
      const controllerInstance = createTemplateController(this.resource as any);
      ctx.registerDefinition(this.resource);
      await ctx.registerController(
        this.resource.metadata.module,
        this.resource.metadata.name,
        controllerInstance,
      );
      return;
    }
    ctx.emit("ControllerLoading", { controllers: this.resource.controllers });
    try {
      const controllerInstance = await this.controllerLoader.load(
        this.resource.controllers,
        this.resource.metadata.source,
        ctx.getControllerPolicy(),
      );
      ctx.emit("ControllerLoaded", { schema: controllerInstance.schema });
      ctx.registerDefinition(this.resource);
      await ctx.registerController(
        this.resource.metadata.module,
        this.resource.metadata.name,
        controllerInstance,
      );
    } catch (err) {
      ctx.emit("ControllerLoadFailed", { error: (err as Error).message });
      throw err;
    }
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
  const definition = resource as unknown as ResourceDefinitionResource;
  return new ResourceDefinition(definition, new ControllerLoader());
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
