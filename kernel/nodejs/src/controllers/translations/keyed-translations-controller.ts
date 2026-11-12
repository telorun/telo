import { kindDeclarationOf } from "@telorun/analyzer";
import type {
  ControllerInstance,
  ResourceContext,
  ResourceInstance,
  ResourceManifest,
} from "@telorun/sdk";
import { RuntimeError } from "@telorun/sdk";
import {
  forgetRegisteredDefinition,
  recordRegisteredDefinition,
} from "../resource-definition/registered-definitions.js";

/**
 * `Telo.KeyedTranslations` — registers the kind its document declares: the
 * `Telo.Translations` kind whose `messages:` translate the document's keys
 * (`kindDeclarationOf`, the analyzer's synthesized definition), whose author
 * schema extends the abstract's `lang`. Its resources
 * are catalogs, pure configuration: the kernel judges them when they are
 * created and layers each one the root Application lists over the keys' source
 * wording.
 */
class KeyedTranslationsDeclaration implements ResourceInstance {
  constructor(private readonly resource: ResourceManifest) {}

  init(ctx: ResourceContext) {
    return ctx.effect(`Telo.KeyedTranslations ${this.resource.metadata.name}`, async () => {
      const definition = kindDeclarationOf(this.resource)!;
      // The kind extends the built-in `Telo.Translations`, registered under that name.
      const parent = typeof definition.extends === "string" ? definition.extends : undefined;
      if (parent && !ctx.moduleContext.getDefinition?.(parent)) {
        throw new RuntimeError("ERR_FATAL", `the built-in kind '${parent}' a keyed set extends is not registered`);
      }
      ctx.registerDefinition(definition);
      await ctx.registerController(definition.metadata.module, definition.metadata.name, keyedCatalogController);
      recordRegisteredDefinition(ctx.moduleContext, this.resource, ctx.getControllerPolicy());
      return {
        result: undefined,
        inverse: () =>
          forgetRegisteredDefinition(ctx.moduleContext, this.resource, ctx.getControllerPolicy()),
      };
    });
  }
}

/** A catalog of a keyed set: publishes what it was written with. */
class KeyedCatalog implements ResourceInstance {
  constructor(private readonly resource: ResourceManifest) {}

  snapshot(): Record<string, unknown> {
    return { lang: this.resource.lang, messages: this.resource.messages };
  }
}

const keyedCatalogController: ControllerInstance = {
  async create(resource: ResourceManifest): Promise<ResourceInstance> {
    return new KeyedCatalog(resource);
  },
};

export function register(): void {}

export async function create(resource: ResourceManifest): Promise<ResourceInstance> {
  return new KeyedTranslationsDeclaration(resource);
}
