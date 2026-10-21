import type { ResourceInstance, ResourceManifest } from "@telorun/sdk";

interface CatalogResource extends ResourceManifest {
  lang: string;
  texts: readonly unknown[];
}

/**
 * `I18n.Catalog`: configuration a translator reads as data. The kernel judges
 * every entry when the catalog is created; the instance only publishes what was
 * declared.
 */
export function create(resource: CatalogResource): ResourceInstance {
  return {
    snapshot: () => ({ lang: resource.lang, texts: resource.texts }),
  };
}
