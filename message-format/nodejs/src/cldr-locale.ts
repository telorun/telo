/**
 * Which CLDR data a language tag reads. A tag resolves case-insensitively, with its
 * extensions (from the first singleton on) set aside, by CLDR inheritance:
 *
 * - number data through the main component — an explicit parent, else the root for
 *   `lang-Script` whose script is not the language's likely one (`nonlikelyScript`),
 *   else truncation;
 * - plural rules through the plurals component's own parents, else truncation.
 *
 * Every chain ends at the root, so an unknown tag reads the root's data: the one
 * category `other`, Latin digits, `.` and `,`, `#,##0.###`.
 */

import { CLDR_NUMBERS, CLDR_PARENT_LOCALES, CLDR_PLURALS } from "./cldr-data.js";
import type { CldrNumberEntry } from "./cldr-tables.js";
import { asciiLowercase } from "./language-lookup.js";
import { PLURAL_CATEGORIES, type PluralCategory } from "./message-model.js";
import { parsePluralRule, type PluralRule } from "./plural-rule.js";

export const CLDR_VERSION: string = CLDR_PLURALS.cldrVersion;

const ROOT = "root";

const lowercased = <T>(table: Readonly<Record<string, T>>): ReadonlyMap<string, T> =>
  new Map(Object.entries(table).map(([key, value]) => [asciiLowercase(key), value]));

let tables:
  | {
      numbers: ReadonlyMap<string, CldrNumberEntry>;
      plurals: ReadonlyMap<string, Readonly<Partial<Record<PluralCategory, string>>>>;
      mainParents: ReadonlyMap<string, string>;
      pluralParents: ReadonlyMap<string, string>;
      likelyScripts: ReadonlyMap<string, string>;
    }
  | undefined;

function cldr() {
  tables ??= {
    numbers: lowercased(CLDR_NUMBERS.locales),
    plurals: lowercased(CLDR_PLURALS.rules),
    mainParents: new Map([...lowercased(CLDR_PARENT_LOCALES.main)].map(([key, value]) => [key, asciiLowercase(value)])),
    pluralParents: new Map(
      [...lowercased(CLDR_PARENT_LOCALES.plurals)].map(([key, value]) => [key, asciiLowercase(value)]),
    ),
    likelyScripts: new Map([...lowercased(CLDR_PARENT_LOCALES.likelyScripts)].map(([key, value]) => [key, asciiLowercase(value)])),
  };
  return tables;
}

/** The tag a lookup starts from: lowercase, without its extensions. */
function lookupStart(tag: string): string {
  const subtags = asciiLowercase(tag).split("-");
  const singleton = subtags.findIndex((subtag, index) => index > 0 && subtag.length === 1);
  const kept = singleton === -1 ? subtags : subtags.slice(0, singleton);
  const start = kept.join("-");
  return start === "" ? ROOT : start;
}

function truncate(tag: string): string {
  const cut = tag.lastIndexOf("-");
  return cut === -1 ? ROOT : tag.slice(0, cut);
}

function mainParent(tag: string): string | null {
  if (tag === ROOT) return null;
  const { mainParents, likelyScripts } = cldr();
  const explicit = mainParents.get(tag);
  if (explicit !== undefined) return explicit;
  const subtags = tag.split("-");
  if (subtags.length === 2 && /^[a-z]{4}$/.test(subtags[1]) && likelyScripts.get(subtags[0]) !== subtags[1]) {
    return ROOT;
  }
  return truncate(tag);
}

function pluralParent(tag: string): string | null {
  if (tag === ROOT) return null;
  return cldr().pluralParents.get(tag) ?? truncate(tag);
}

function resolve<T>(table: ReadonlyMap<string, T>, tag: string, parent: (tag: string) => string | null): [string, T] {
  for (let at: string | null = lookupStart(tag); at !== null; at = parent(at)) {
    const found = table.get(at);
    if (found !== undefined) return [at, found];
  }
  throw new Error("the CLDR data has no root locale");
}

export function numberEntryFor(tag: string): CldrNumberEntry {
  return resolve(cldr().numbers, tag, mainParent)[1];
}

export interface PluralRuleSet {
  readonly categories: readonly PluralCategory[];
  /** The rule of each category but `other`, in category order. */
  readonly rules: readonly (readonly [PluralCategory, PluralRule])[];
}

const ruleSets = new Map<string, PluralRuleSet>();

export function pluralRuleSetFor(tag: string): PluralRuleSet {
  const [locale, written] = resolve(cldr().plurals, tag, pluralParent);
  let set = ruleSets.get(locale);
  if (set === undefined) {
    const categories = PLURAL_CATEGORIES.filter((category) => written[category] !== undefined);
    set = {
      categories,
      rules: categories
        .filter((category) => category !== "other")
        .map((category) => [category, parsePluralRule(written[category]!)] as const),
    };
    ruleSets.set(locale, set);
  }
  return set;
}

/** The plural categories `lang` has, in CLDR's order (`other` last). */
export function pluralCategories(lang: string): readonly PluralCategory[] {
  return pluralRuleSetFor(lang).categories;
}
