import {
  messageIdentity,
  readMessage,
  truncationChain,
  type Message,
  type MessageSource,
  type TextRecord,
} from "@telorun/sdk";

/**
 * A translator's catalogs, indexed for lookup: what `I18n.Translator` formats
 * from, and what `@telorun/i18n` hands a dependent module's controller.
 */
export interface CatalogSet {
  /** Every catalog language, in set order, each once — a tag written twice in
   *  different case is the first one written. */
  readonly languages: readonly string[];
  /**
   * The translation of a text into `lang`: the requested tag first, then each
   * shorter variant (`pl-Latn-PL` → `pl-Latn` → `pl`), and the language of the
   * catalog that translates it. `null` when no catalog translates it, and for a
   * computed text, which is never looked up.
   */
  lookup(text: TextRecord, lang: string): { message: Message; lang: string } | null;
}

/** One catalog as a translator receives it: its configuration, as data. */
export interface CatalogView {
  readonly lang: string;
  readonly texts: readonly {
    readonly text: MessageSource;
    readonly context?: string;
    readonly translation: MessageSource;
  }[];
}

/** Where a translator instance carries its set. */
export const CATALOG_SET = Symbol.for("telo.i18n.catalogSet");

const asciiLowercase = (text: string): string =>
  text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));

const keyOf = (source: string, context: string | null): string => JSON.stringify([source, context]);

export function parsed(source: MessageSource, what: string): Message {
  const read = readMessage(source);
  if (!read.ok) {
    throw new Error(`${what} is not a message: ${read.problems.map((problem) => problem.message).join("; ")}`);
  }
  return read.message;
}

/** Indexes a translator's catalogs. Each entry was judged where the catalog was
 *  created, and the set as a whole before the translator was. */
export function buildCatalogSet(catalogs: readonly CatalogView[]): CatalogSet {
  const byLanguage = new Map<string, Map<string, { message: Message; lang: string }>>();
  const languages: string[] = [];
  catalogs.forEach((catalog, at) => {
    const language = asciiLowercase(catalog.lang);
    let index = byLanguage.get(language);
    if (!index) {
      byLanguage.set(language, (index = new Map()));
      languages.push(catalog.lang);
    }
    catalog.texts.forEach((entry, entryAt) => {
      const where = `catalogs[${at}].texts[${entryAt}]`;
      const key = keyOf(messageIdentity(parsed(entry.text, `${where}.text`)), entry.context ?? null);
      if (index.has(key)) {
        throw new Error(`${where} translates a text already translated into ${catalog.lang} by this catalog set`);
      }
      index.set(key, { message: parsed(entry.translation, `${where}.translation`), lang: catalog.lang });
    });
  });
  return {
    languages,
    lookup(text, lang) {
      if (text.computed) return null;
      const key = keyOf(messageIdentity(parsed(text.text, "the text")), text.context);
      for (const tag of truncationChain(lang)) {
        const found = byLanguage.get(asciiLowercase(tag))?.get(key);
        if (found) return found;
      }
      return null;
    },
  };
}

const built = new WeakMap<object, CatalogSet>();

/**
 * The catalog set of a translator: the live `I18n.Translator` instance a
 * controller holds, or the translator's configuration a function receives as
 * data at a dependency slot (`{ catalogs: [{ lang, texts }] }`).
 */
export function catalogSetOf(translator: unknown): CatalogSet {
  if (translator && typeof translator === "object") {
    const carried = (translator as { [CATALOG_SET]?: CatalogSet })[CATALOG_SET];
    if (carried) return carried;
    const catalogs = (translator as { catalogs?: unknown }).catalogs;
    if (catalogs === undefined || Array.isArray(catalogs)) {
      let set = built.get(translator);
      if (!set) built.set(translator, (set = buildCatalogSet((catalogs ?? []) as readonly CatalogView[])));
      return set;
    }
  }
  throw new TypeError(
    "catalogSetOf takes an I18n.Translator instance, or a translator's configuration { catalogs }",
  );
}
