import { effectiveAuthorSchema, kindDeclarationOf, type DefResolver } from "@telorun/analyzer";
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
 * (`kindDeclarationOf`, the analyzer's synthesized definition), registered with
 * its author schema merged over the abstract's `lang`. Its resources
 * are catalogs, pure configuration: the kernel judges them when they are
 * created and layers each one the root Application lists over the keys' source
 * wording.
 */
class KeyedTranslationsDeclaration implements ResourceInstance {
  constructor(private readonly resource: ResourceManifest) {}

  init(ctx: ResourceContext) {
    return ctx.effect(`Telo.KeyedTranslations ${this.resource.metadata.name}`, async () => {
      const declared = kindDeclarationOf(this.resource)!;
      // The kind extends the built-in `Telo.Translations`, registered under that name.
      const resolveDef: DefResolver = (kind) => {
        const definition = ctx.moduleContext.getDefinition?.(kind);
        if (!definition) {
          throw new RuntimeError("ERR_FATAL", `the built-in kind '${kind}' a keyed set extends is not registered`);
        }
        return definition;
      };
      const definition = { ...declared, schema: effectiveAuthorSchema(declared, resolveDef) };
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
