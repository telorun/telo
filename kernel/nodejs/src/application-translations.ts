/**
 * **The application's translations** — the root Application's
 * `translations.catalogs`, layered into one set every module is translated
 * through, plus the one negotiation every transport chooses a language with.
 *
 * Per language (tags compared case-insensitively), the catalogs apply in list
 * order and a later one's translation of a text and context replaces an
 * earlier one's: a repeat across catalogs is an override, never an error. A
 * repeat within one catalog is that catalog's own `MESSAGE_ENTRY_DUPLICATE`,
 * refused where it is created. Texts are matched by the message core's identity,
 * so a library's text is translated whichever module wrote it.
 *
 * A keyed catalog is layered by the same rule per key, over its set's source
 * wording, and is read only by the kinds naming its set in `x-telo-text-keys`.
 */
import { isResolvedReference, judgeCatalog, teloFormatFailure, textKey } from "@telorun/analyzer";
import {
  lookupLanguage,
  messageIdentity,
  readMessage,
  RuntimeError,
  type KeyedMessages,
  type MessageSource,
  type TextRecord,
} from "@telorun/sdk";

/** One `translations.catalogs` entry, as the loader leaves it: a reference. */
export interface ListedCatalog {
  /** `translations.catalogs[1]` — how a message names the entry. */
  readonly entry: string;
  readonly name: string;
  /** Set for `!ref <Alias>.<name>`: an instance an import exports. */
  readonly alias?: string;
}

/** The catalog references the root Application's `translations:` block lists, in order. */
export function readListedCatalogs(block: unknown): ListedCatalog[] {
  const catalogs = (block as { catalogs?: unknown } | undefined)?.catalogs;
  if (!Array.isArray(catalogs)) return [];
  return catalogs.map((ref, index) => {
    const entry = `translations.catalogs[${index}]`;
    if (!isResolvedReference(ref)) {
      throw new RuntimeError(
        "ERR_MANIFEST_VALIDATION_FAILED",
        `${entry} does not name translations: write \`!ref <name>\` or an inline \`Telo.TextTranslations\`.`,
      );
    }
    return { entry, name: ref.name, ...(typeof ref.alias === "string" ? { alias: ref.alias } : {}) };
  });
}

/** One listed catalog, read: its language and its configuration. */
export interface ReadCatalog {
  readonly lang: string;
  /** The configuration its controller received — a `texts:` list, or a keyed
   *  catalog's `messages:` map, is read from it. */
  readonly configuration: unknown;
  /** The canonical kind of the keyed set it translates, for a keyed catalog. */
  readonly keyedSet?: string;
}

/** One keyed set as its declaration writes it: the source wording of each key,
 *  in the language of the module declaring it. */
export interface KeyedSource {
  /** The set's canonical kind. */
  readonly kind: string;
  readonly lang: string;
  readonly keys: Readonly<Record<string, { readonly message: unknown }>>;
}

interface Translation {
  readonly lang: string;
  readonly text: MessageSource;
}

const asciiLowercase = (text: string): string =>
  text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));

const isLanguageTag = (tag: unknown): tag is string =>
  typeof tag === "string" && tag !== "" && teloFormatFailure("language-tag", tag) === undefined;

/** The layered set over the catalogs as read, and the negotiation over its languages. */
export class TranslationSet {
  readonly languages: readonly string[];
  /** Text key → language key → the translation the last catalog gives. */
  private readonly byText = new Map<string, Map<string, Translation>>();
  /** Keyed set → key → language key → the translation the last catalog gives. */
  private readonly byKey = new Map<string, Map<string, Map<string, Translation>>>();
  /** Each keyed set's layered messages, built the first time it is asked for. */
  private readonly layeredKeys = new Map<string, KeyedMessages[string]>();

  constructor(
    readonly fallback: string,
    catalogs: readonly ReadCatalog[],
  ) {
    const served = new Map<string, string>([[asciiLowercase(fallback), fallback]]);
    for (const catalog of catalogs) {
      const language = asciiLowercase(catalog.lang);
      if (!served.has(language)) served.set(language, catalog.lang);
      if (catalog.keyedSet !== undefined) {
        this.layerKeyed(catalog.keyedSet, language, served.get(language)!, catalog.configuration);
        continue;
      }
      const texts = (catalog.configuration as { texts?: unknown } | null)?.texts;
      if (!Array.isArray(texts)) continue;
      for (const entry of judgeCatalog(catalog.configuration, () => false).entries) {
        const written = texts[entry.index] as { translation: MessageSource };
        let languages = this.byText.get(entry.key);
        if (!languages) this.byText.set(entry.key, (languages = new Map()));
        languages.set(language, { lang: served.get(language)!, text: written.translation });
      }
    }
    this.languages = [...served.values()];
  }

  private layerKeyed(set: string, language: string, lang: string, configuration: unknown): void {
    const messages = (configuration as { messages?: unknown } | null)?.messages;
    if (!messages || typeof messages !== "object") return;
    let keys = this.byKey.get(set);
    if (!keys) this.byKey.set(set, (keys = new Map()));
    for (const [key, text] of Object.entries(messages as Record<string, MessageSource>)) {
      let languages = keys.get(key);
      if (!languages) keys.set(key, (languages = new Map()));
      languages.set(language, { lang, text });
    }
  }

  /**
   * The application translations rule applied per key: for every served language,
   * each key's message is the translation reached from it by RFC 4647 lookup among
   * the languages translating that key and the source's, else the source wording.
   */
  keyed(source: KeyedSource): KeyedMessages[string] {
    const known = this.layeredKeys.get(source.kind);
    if (known) return known;
    const translated = this.byKey.get(source.kind);
    const byLanguage: Record<string, Readonly<Record<string, TextRecord>>> = {};
    for (const served of this.languages) {
      const messages: Record<string, TextRecord> = {};
      for (const [key, entry] of Object.entries(source.keys)) {
        const languages = translated?.get(key);
        const reached = languages
          ? lookupLanguage(served, [...[...languages.values()].map((translation) => translation.lang), source.lang])
          : null;
        const translation = reached === null ? undefined : languages!.get(asciiLowercase(reached));
        messages[key] = translation
          ? { text: translation.text, context: null, lang: translation.lang, computed: false }
          : { text: entry.message as MessageSource, context: null, lang: source.lang, computed: false };
      }
      byLanguage[served] = Object.freeze(messages);
    }
    const layered = Object.freeze(byLanguage);
    this.layeredKeys.set(source.kind, layered);
    return layered;
  }

  negotiate(preferences: Iterable<string>): string {
    for (const preference of preferences) {
      if (!isLanguageTag(preference)) continue;
      const found = lookupLanguage(preference, this.languages);
      if (found !== null) return found;
    }
    return this.fallback;
  }

  translate(lang: string, text: TextRecord): TextRecord {
    if (text.computed) return text;
    const read = readMessage(text.text);
    if (!read.ok) {
      throw new RuntimeError(
        "ERR_MESSAGE_SYNTAX_INVALID",
        `A text to translate does not read: ${read.problems.map((problem) => problem.message).join("; ")}.`,
      );
    }
    const languages = this.byText.get(textKey(messageIdentity(read.message), text.context));
    if (!languages) return text;
    const reached = lookupLanguage(this.negotiate([lang]), [
      ...[...languages.values()].map((translation) => translation.lang),
      text.lang,
    ]);
    const translation = reached === null ? undefined : languages.get(asciiLowercase(reached));
    if (!translation) return text;
    return { text: translation.text, context: text.context, lang: translation.lang, computed: false };
  }
}
