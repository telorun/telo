import type { TextRecord } from "./text-record.js";

/**
 * The application's translations, as a controller reads them (`ctx.translations`).
 *
 * The root Application lists them once, in its `translations.catalogs`; the kernel
 * layers them per language, a later catalog's translation of a text replacing an
 * earlier one's, and every module of the application — an imported library's
 * included, isolated or shared — is translated through that one set.
 *
 * The SERVED languages are the application's own `lang:` (the fallback, `und` when it
 * declares none) and every listed catalog's `lang`. A transport chooses the language
 * of each inbound request with {@link negotiate} and hands the result on; a text is
 * then shown in it with {@link translate}.
 *
 * Every member but {@link fallback} reads the listed catalogs. Asked during startup,
 * before each of them exists, it raises the deferral the init loop retries
 * (`ERR_LOCAL_REF_PENDING`, or `ERR_CROSS_MODULE_REF_PENDING` for one an import
 * exports), so a controller asking from `init()` is simply initialized later.
 *
 * The protocol's `Translations.Lookup`.
 */
export interface ApplicationTranslations {
  /** The application's own language: its `lang:`, else `und`. */
  readonly fallback: string;
  /** Every served language, the fallback first, then each catalog's in list order,
   *  once each (compared case-insensitively), spelled as first written. */
  languages(): readonly string[];
  /**
   * The served language a preference list lands on: each entry in order is matched
   * by RFC 4647 lookup (`pl-PL` finds `pl`), and the first that finds one wins; an
   * entry that is not a well-formed language tag, or finds none, is skipped; with
   * none left, the fallback.
   */
  negotiate(preferences: Iterable<string>): string;
  /**
   * `text` shown in `lang`: `lang` is negotiated first (so any tag may be passed),
   * then the layered set's translation of the text and its context is looked up by
   * RFC 4647 among the languages translating it and the text's own. Answers the
   * translation as a record — `lang` the language reached, `context` and `computed`
   * the text's own — or `text` itself when nothing translates it there, or when an
   * expression produced it (`computed`), which is never looked up.
   */
  translate(lang: string, text: TextRecord): TextRecord;
  /** {@link translate} over several texts at once, in order. */
  translateAll(lang: string, texts: readonly TextRecord[]): TextRecord[];
  /**
   * The keyed texts this resource's kind shows — every set its schema root names in
   * `x-telo-text-keys`, and nothing for any other — layered per served language
   * (see {@link KeyedMessages}).
   */
  keyed(): KeyedMessages;
}

/**
 * Keyed texts, by the canonical kind of each set (`<Module>.<Kind>`), then by
 * every served language, then by key. Per key, a language's message is the
 * listed catalog of the set reached from it by RFC 4647 lookup — the last such
 * catalog in `translations.catalogs` order — else the source wording its
 * `Telo.KeyedTranslations` declaration writes; each as a record whose `lang` is
 * the language it is written in.
 */
export type KeyedMessages = Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, TextRecord>>>>>
>;
