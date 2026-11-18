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

/** The connectives coverage is decided over: one configuration's booleans,
 *  or conditions over every configuration at once. */
export interface CoverageLogic<T> {
  readonly TRUE: T;
  readonly FALSE: T;
  and(a: T, b: T): T;
  or(a: T, b: T): T;
  not(a: T): T;
  isFalse(a: T): boolean;
}

/** A served language, a layer, a shown text or a shown keyed set, with where
 *  it is there. */
export interface HeldCoverage<T> {
  readonly served: readonly { readonly lang: string; readonly held: T }[];
  readonly layers: readonly (TranslationLayer & { readonly held: T })[];
  /** Each text by identity, with where it is shown. */
  readonly texts: readonly { readonly lang: string; readonly keys: ReadonlyMap<string, T> }[];
  readonly keyedSets: readonly (ShownKeyedSet & { readonly held: T })[];
}

/** What shows its source in a served language, each item with where it does. */
export interface HeldMissing<T> {
  readonly lang: string;
  readonly set?: string;
  readonly missing: readonly { readonly item: string; readonly held: T }[];
}

/** {@link missingTranslations}' rule over `logic`: every candidate entry, in
 *  served order, each item with where it is reported. */
export function missingTranslationsOver<T>(logic: CoverageLogic<T>, input: HeldCoverage<T>): HeldMissing<T>[] {
  const { layers, texts, keyedSets } = input;
  const served = new Map<string, { lang: string; held: T }>();
  for (const { lang, held } of input.served) {
    const key = asciiLowercase(lang);
    const known = served.get(key);
    served.set(key, known ? { lang: known.lang, held: logic.or(known.held, held) } : { lang, held });
  }
  // Reached from `lang`: the source, or a layer translating the item.
  const reached = (lang: string, source: string, translating: readonly { lang: string; held: T }[]): T =>
    lookupLanguage(lang, [source]) !== null
      ? logic.TRUE
      : translating.reduce((at, layer) => (lookupLanguage(lang, [layer.lang]) !== null ? logic.or(at, layer.held) : at), logic.FALSE);
  const missingAt = new Map<string, { lang: string; set?: string; missing: Map<string, T> }[]>();
  for (const [key, { lang, held }] of served) {
    if (key === UNDETERMINED_LANGUAGE) continue;
    const found: { lang: string; set?: string; missing: Map<string, T> }[] = [];
    for (const shown of keyedSets) {
      const missing = new Map<string, T>();
      for (const item of shown.keys) {
        const translating = layers.filter((layer) => layer.keyed.get(shown.set)?.has(item) === true);
        const at = logic.and(logic.and(held, shown.held), logic.not(reached(lang, shown.lang, translating)));
        if (!logic.isFalse(at)) missing.set(item, at);
      }
      if (missing.size > 0) found.push({ lang, set: shown.set, missing });
    }
    const missingTexts = new Map<string, T>();
    for (const group of texts) {
      for (const [item, shown] of group.keys) {
        const translating = layers.filter((layer) => layer.texts.has(item));
        const at = logic.and(logic.and(held, shown), logic.not(reached(lang, group.lang, translating)));
        if (!logic.isFalse(at)) missingTexts.set(item, logic.or(missingTexts.get(item) ?? logic.FALSE, at));
      }
    }
    if (missingTexts.size > 0) found.push({ lang, missing: missingTexts });
    missingAt.set(key, found);
  }

  const out: HeldMissing<T>[] = [];
  for (const [key, { lang }] of served) {
    const found = missingAt.get(key);
    if (!found) continue;
    const covering = truncationChain(lang)
      .slice(1)
      .flatMap((shorter) => missingAt.get(asciiLowercase(shorter)) ?? []);
    for (const entry of found) {
      const missing: { item: string; held: T }[] = [];
      for (const [item, at] of entry.missing) {
        const reported = covering
          .filter((c) => c.set === entry.set)
          .reduce((r, c) => logic.or(r, c.missing.get(item) ?? logic.FALSE), logic.FALSE);
        const held = logic.and(at, logic.not(reported));
        if (!logic.isFalse(held)) missing.push({ item, held });
      }
      if (missing.length > 0) out.push({ lang, ...(entry.set !== undefined ? { set: entry.set } : {}), missing });
    }
  }
  return out;
}

const ONE_CONFIGURATION: CoverageLogic<boolean> = {
  TRUE: true,
  FALSE: false,
  and: (a, b) => a && b,
  or: (a, b) => a || b,
  not: (a) => !a,
  isFalse: (a) => !a,
};

/** Every item that shows its source in a served language, one entry per
 *  (language, keyed set) and one per language for texts, in served order. */
export function missingTranslations(input: {
  readonly served: readonly string[];
  readonly layers: readonly TranslationLayer[];
  readonly texts: readonly ShownTexts[];
  readonly keyedSets: readonly ShownKeyedSet[];
}): MissingTranslations[] {
  return missingTranslationsOver(ONE_CONFIGURATION, {
    served: input.served.map((lang) => ({ lang, held: true })),
    layers: input.layers.map((layer) => ({ ...layer, held: true })),
    texts: input.texts.map((group) => ({ lang: group.lang, keys: new Map([...group.keys].map((key) => [key, true])) })),
    keyedSets: input.keyedSets.map((set) => ({ ...set, held: true })),
  }).map(({ lang, set, missing }) => ({ lang, ...(set !== undefined ? { set } : {}), missing: missing.map((m) => m.item) }));
}
