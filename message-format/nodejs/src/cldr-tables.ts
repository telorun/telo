/**
 * The shapes of the three tracked CLDR files under `message-format/cldr/`, as
 * `scripts/generate-cldr-data.mjs` writes them. Locale keys are CLDR's, with the root
 * locale named `root`.
 */

import type { PluralCategory } from "./message-model.js";

export interface CldrPluralsFile {
  readonly cldrVersion: string;
  /** Each locale's cardinal rules, verbatim: the condition, then its samples. */
  readonly rules: Readonly<Record<string, Readonly<Partial<Record<PluralCategory, string>>>>>;
}

export interface CldrNumberEntry {
  /** The ten digits of the default numbering system, zero first. */
  readonly digits: string;
  readonly decimal: string;
  readonly group: string;
  readonly minusSign: string;
  /** The standard decimal pattern. */
  readonly pattern: string;
  readonly minimumGroupingDigits: string;
}

export interface CldrNumbersFile {
  readonly cldrVersion: string;
  /** An entry equal to what its parent resolves to is omitted. */
  readonly locales: Readonly<Record<string, CldrNumberEntry>>;
}

export interface CldrParentLocalesFile {
  readonly cldrVersion: string;
  /** The main component's parents: number data inherits through these. */
  readonly main: Readonly<Record<string, string>>;
  /** The plurals component's parents, which stand alone. */
  readonly plurals: Readonly<Record<string, string>>;
  /** Each language's likely script: `lang-Script` with another script has the root as parent. */
  readonly likelyScripts: Readonly<Record<string, string>>;
}
