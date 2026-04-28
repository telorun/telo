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

  constructor(readonly resource: ResourceDefinitionResource) {}

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
    // The loader owns ControllerLoading / ControllerLoaded / ControllerLoadFailed
    // emission so it can fire one event per attempted candidate (env-missing
    // fallback chains), and so the payload can include the actually-picked PURL,
    // which branch resolved it (`source`), and timing — none of which are known
    // here at the call site.
    const loader = new ControllerLoader({
      emit: (e) => ctx.emit(e.name, e.payload),
    });
    const controllerInstance = await loader.load(
      this.resource.controllers,
      this.resource.metadata.source,
      ctx.getControllerPolicy(),
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
  const definition = resource as unknown as ResourceDefinitionResource;
  return new ResourceDefinition(definition);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
