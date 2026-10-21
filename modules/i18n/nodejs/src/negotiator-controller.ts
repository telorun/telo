import { lookupLanguage, type FunctionController, type ResourceManifest } from "@telorun/sdk";
import { languagePreferences } from "./accept-language.js";
import { catalogSetOf } from "./catalog-set.js";

interface NegotiatorResource extends ResourceManifest {
  /** The translator's configuration, delivered as data. */
  translator: unknown;
  default: string;
}

/**
 * `I18n.Negotiator`: the language to answer in — the first preference, by
 * quality, that a catalog language or the default answers by RFC 4647 lookup;
 * the default when none does.
 */
export const Negotiator: FunctionController<NegotiatorResource, { acceptLanguage: string }, string> = {
  create(resource) {
    const available = [...catalogSetOf(resource.translator).languages, resource.default];
    return {
      call({ acceptLanguage }) {
        for (const range of languagePreferences(acceptLanguage)) {
          const found = lookupLanguage(range, available);
          if (found !== null) return found;
        }
        return resource.default;
      },
    };
  },
};
