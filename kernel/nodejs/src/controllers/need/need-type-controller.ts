import { kindDeclarationOf, needTypeOf } from "@telorun/analyzer";
import type { ResourceContext, ResourceInstance, ResourceManifest } from "@telorun/sdk";
import { needFulfilmentController } from "../../need-fulfilment.js";
import {
  forgetRegisteredDefinition,
  recordRegisteredDefinition,
} from "../resource-definition/registered-definitions.js";

/**
 * `Telo.NeedType` — registers the kind its document declares.
 *
 * The kind is the definition the analyzer synthesizes from the same document
 * (`kindDeclarationOf`): a `Telo.Provider` whose author schema is the closed
 * `fields:` map a self-supplied fulfilment writes. Its controller is the kernel's need-type
 * controller, registered directly — nothing is loaded.
 */
class NeedTypeDeclaration implements ResourceInstance {
  constructor(private readonly resource: ResourceManifest) {}

  init(ctx: ResourceContext) {
    return ctx.effect(`Telo.NeedType ${this.resource.metadata.name}`, async () => {
      const definition = kindDeclarationOf(this.resource)!;
      const shape = needTypeOf(definition)!;
      const module = definition.metadata.module;
      const name = definition.metadata.name;
      ctx.registerDefinition(definition);
      await ctx.registerController(module, name, needFulfilmentController(`${module}.${name}`, shape));
      recordRegisteredDefinition(ctx.moduleContext, this.resource, ctx.getControllerPolicy());
      return {
        result: undefined,
        inverse: () =>
          forgetRegisteredDefinition(ctx.moduleContext, this.resource, ctx.getControllerPolicy()),
      };
    });
  }
}

export function register(): void {}

export async function create(resource: ResourceManifest): Promise<ResourceInstance> {
  return new NeedTypeDeclaration(resource);
}
