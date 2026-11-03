/**
 * The built-in translations — the `Telo.Builtins` archive's `translations`
 * section: one text catalog per language translating the built-in error codes'
 * display messages (`sdk/translations/`, see the README there).
 *
 * They are the LOWEST layer of every application's translations, beneath every
 * catalog its `translations.catalogs` lists, and they never add a served
 * language. The kernel's translation set and `telo check`'s coverage reader both
 * layer them from here, so a run and a check agree on what they translate.
 *
 * Browser-safe — no I/O, no Node built-ins.
 */
import { BUILTIN_TRANSLATION_FILES } from "./builtin-entries/index.js";

/** One built-in catalog: its language and its `TextCatalog` value. */
export interface BuiltinTranslationCatalog {
  readonly lang: string;
  readonly catalog: { readonly lang: string; readonly texts: readonly unknown[] };
}

const CATALOGS: readonly BuiltinTranslationCatalog[] = Object.freeze(
  BUILTIN_TRANSLATION_FILES.map(([lang, data]) =>
    Object.freeze({ lang, catalog: data as BuiltinTranslationCatalog["catalog"] }),
  ),
);

/** Every built-in catalog, by language in lexical order. */
export function builtinTranslationCatalogs(): readonly BuiltinTranslationCatalog[] {
  return CATALOGS;
}
