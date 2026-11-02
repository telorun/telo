import type { ResourceInstance, ResourceManifest } from "@telorun/sdk";

/**
 * `Telo.TextTranslations` — one language's translations, matched by source text
 * and context. Pure configuration: the kernel judges its entries when it is
 * created, layers it into the application's set when the root Application's
 * `translations.catalogs` lists it, and it publishes what it was written with.
 */
class TextTranslations implements ResourceInstance {
  constructor(private readonly resource: ResourceManifest) {}

  snapshot(): Record<string, unknown> {
    return { lang: this.resource.lang, texts: this.resource.texts };
  }
}

export function register(): void {}

export async function create(resource: ResourceManifest): Promise<ResourceInstance> {
  return new TextTranslations(resource);
}
