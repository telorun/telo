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
 */
import { isResolvedReference, judgeCatalog, teloFormatFailure, textKey } from "@telorun/analyzer";
import {
  lookupLanguage,
  messageIdentity,
  readMessage,
  RuntimeError,
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
  /** The configuration its controller received — a `texts:` list is read from it. */
  readonly configuration: unknown;
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

  constructor(
    readonly fallback: string,
    catalogs: readonly ReadCatalog[],
  ) {
    const served = new Map<string, string>([[asciiLowercase(fallback), fallback]]);
    for (const catalog of catalogs) {
      const language = asciiLowercase(catalog.lang);
      if (!served.has(language)) served.set(language, catalog.lang);
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
