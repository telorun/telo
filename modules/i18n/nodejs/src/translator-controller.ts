import {
  formatMessage,
  isCelUint,
  type FunctionController,
  type MessageValue,
  type ResourceManifest,
  type TextRecord,
} from "@telorun/sdk";
import { buildCatalogSet, CATALOG_SET, parsed, type CatalogView } from "./catalog-set.js";

interface TranslatorResource extends ResourceManifest {
  /** Each catalog's configuration, delivered as data. */
  catalogs?: readonly CatalogView[];
}

interface TranslateArgs extends Record<string, unknown> {
  text: TextRecord;
  lang: string;
  values?: Record<string, unknown> | null;
}

/** A CEL `uint` is formatted as the integer it is. */
function messageValues(values: Record<string, unknown>): Record<string, MessageValue> {
  const out: Record<string, MessageValue> = {};
  for (const [name, value] of Object.entries(values)) {
    out[name] = (isCelUint(value) ? value.value : value) as MessageValue;
  }
  return out;
}

/**
 * `I18n.Translator`: a text translated into the requested language, or formatted
 * as written in its own language when no catalog translates it.
 */
export const Translator: FunctionController<TranslatorResource, TranslateArgs, string> = {
  create(resource) {
    const set = buildCatalogSet(resource.catalogs ?? []);
    return {
      [CATALOG_SET]: set,
      call({ text, lang, values }) {
        const found = set.lookup(text, lang);
        return formatMessage(
          found?.message ?? parsed(text.text, "the text"),
          found?.lang ?? text.lang,
          messageValues(values ?? {}),
        );
      },
    };
  },
};
