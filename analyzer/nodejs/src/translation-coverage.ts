/**
 * Translation coverage — THE single reader of what an application shows in a
 * language it serves with nothing translating it (`MESSAGE_TRANSLATION_MISSING`).
 *
 * It reads the LAYERED result of the application's translations — the layers
 * lowest first, the listed catalogs in list order — by the rule the kernel's set
 * answers with at run time: in a served language, an item is translated when RFC
 * 4647 lookup from that language reaches its source language or the language of
 * a layer translating it; otherwise its source is shown. Coverage asks only
 * whether some layer reaches it, so a layer slotted beneath the catalogs changes
 * no other rule. `und` is never judged, and an item missing in a served language
 * is reported there alone, never again for a longer served tag it covers (`pl`
 * covers `pl-PL`).
 *
 * Browser-safe — no I/O, no Node built-ins.
 */
import { lookupLanguage, truncationChain } from "@telorun/sdk";
import { UNDETERMINED_LANGUAGE } from "./text-slot.js";

/** What one layer translates into its `lang`. */
export interface TranslationLayer {
  readonly lang: string;
  /** The texts it translates, by identity (`textKey`). */
  readonly texts: ReadonlySet<string>;
  /** Keyed set (canonical kind) → the keys it translates. */
  readonly keyed: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Texts the application shows, by identity, written in `lang`. */
export interface ShownTexts {
  readonly lang: string;
  readonly keys: ReadonlySet<string>;
}

/** A keyed set the application shows, its source wording in `lang`. */
export interface ShownKeyedSet {
  readonly set: string;
  readonly lang: string;
  readonly keys: readonly string[];
}

/** What shows its source in a served language: a keyed set's keys (`set`), or
 *  texts by identity (no `set`). */
export interface MissingTranslations {
  readonly lang: string;
  readonly set?: string;
  readonly missing: readonly string[];
}

const asciiLowercase = (text: string): string =>
  text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));

/** The languages an application serves: its fallback, then each catalog's
 *  `lang`, once each (compared case-insensitively). */
export function servedLanguages(fallback: string, catalogLangs: Iterable<string>): string[] {
  const served = new Map<string, string>([[asciiLowercase(fallback), fallback]]);
  for (const lang of catalogLangs) {
    const key = asciiLowercase(lang);
    if (!served.has(key)) served.set(key, lang);
  }
  return [...served.values()];
}

/** Every item that shows its source in a served language, one entry per
 *  (language, keyed set) and one per language for texts, in served order. */
export function missingTranslations(input: {
  readonly served: readonly string[];
  readonly layers: readonly TranslationLayer[];
  readonly texts: readonly ShownTexts[];
  readonly keyedSets: readonly ShownKeyedSet[];
}): MissingTranslations[] {
  const { served, layers, texts, keyedSets } = input;
  const textLangs = (key: string) => layers.filter((layer) => layer.texts.has(key)).map((layer) => layer.lang);
  const keyLangs = (set: string, key: string) =>
    layers.filter((layer) => layer.keyed.get(set)?.has(key) === true).map((layer) => layer.lang);
  const reached = (lang: string, source: string, translated: readonly string[]) =>
    lookupLanguage(lang, [source, ...translated]) !== null;

  const missingAt = new Map<string, MissingTranslations[]>();
  for (const lang of served) {
    if (asciiLowercase(lang) === UNDETERMINED_LANGUAGE) continue;
    const found: MissingTranslations[] = [];
    for (const shown of keyedSets) {
      const missing = shown.keys.filter((key) => !reached(lang, shown.lang, keyLangs(shown.set, key)));
      if (missing.length > 0) found.push({ lang, set: shown.set, missing });
    }
    const missingTexts = new Set<string>();
    for (const group of texts) {
      for (const key of group.keys) {
        if (!reached(lang, group.lang, textLangs(key))) missingTexts.add(key);
      }
    }
    if (missingTexts.size > 0) found.push({ lang, missing: [...missingTexts] });
    missingAt.set(asciiLowercase(lang), found);
  }

  const out: MissingTranslations[] = [];
  for (const lang of served) {
    const found = missingAt.get(asciiLowercase(lang));
    if (!found) continue;
    const covering = truncationChain(lang)
      .slice(1)
      .flatMap((shorter) => missingAt.get(asciiLowercase(shorter)) ?? []);
    for (const entry of found) {
      const reported = new Set(covering.filter((c) => c.set === entry.set).flatMap((c) => c.missing));
      const missing = entry.missing.filter((item) => !reported.has(item));
      if (missing.length > 0) out.push({ ...entry, missing });
    }
  }
  return out;
}
