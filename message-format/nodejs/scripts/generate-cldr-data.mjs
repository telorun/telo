/**
 * Writes the tracked CLDR data under `message-format/cldr/` from the exact-pinned
 * `cldr-core` and `cldr-numbers-full` devDependencies, copying CLDR's values verbatim:
 *
 * - `plurals.json` — every locale's cardinal rule strings, samples included;
 * - `numbers.json` — every locale's default-numbering digits, decimal, group and minus
 *   symbols, standard decimal pattern and `minimumGroupingDigits`, an entry equal to
 *   what its parent resolves to omitted;
 * - `parent-locales.json` — the main and the plurals parent maps, and each language's
 *   likely script (the `nonlikelyScript` rule's input);
 * - `LICENSE` — the Unicode License V3 both packages carry.
 *
 * `--check` writes nothing and fails when a tracked file differs from what would be
 * written, so the tracked data provably is the pinned release's.
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cldr");
const CLDR_VERSION = "48.2.0";
const CATEGORIES = ["zero", "one", "two", "few", "many", "other"];
const DECIMAL_PATTERN = /^(?:#+,)*#*0+(?:\.0*#*)?$/;

const coreDir = dirname(require.resolve("cldr-core/package.json"));
const numbersDir = dirname(require.resolve("cldr-numbers-full/package.json"));
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

for (const dir of [coreDir, numbersDir]) {
  const { name, version } = readJson(join(dir, "package.json"));
  if (version !== CLDR_VERSION) throw new Error(`${name} is ${version}; the data is pinned to ${CLDR_VERSION}.`);
}
const license = readFileSync(join(coreDir, "LICENSE"), "utf8");
if (license !== readFileSync(join(numbersDir, "LICENSE"), "utf8")) {
  throw new Error("cldr-core and cldr-numbers-full carry different LICENSE texts.");
}
if (license.includes("*/")) throw new Error("The LICENSE text holds */ and cannot sit in a /*! */ notice.");

const sorted = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const rootName = (tag) => (tag === "und" ? "root" : tag);

// Plurals.
const cardinal = readJson(join(coreDir, "supplemental", "plurals.json")).supplemental["plurals-type-cardinal"];
const rules = {};
for (const [locale, entries] of Object.entries(cardinal)) {
  const set = {};
  for (const [key, rule] of Object.entries(entries)) {
    const category = key.replace(/^pluralRule-count-/, "");
    if (!CATEGORIES.includes(category)) throw new Error(`${locale}: ${key} is no plural category.`);
    set[category] = rule;
  }
  if (!("other" in set)) throw new Error(`${locale} has no other rule.`);
  rules[rootName(locale)] = Object.fromEntries(CATEGORIES.filter((c) => c in set).map((c) => [c, set[c]]));
}

// Numbers, in full.
const numberingSystems = readJson(join(coreDir, "supplemental", "numberingSystems.json")).supplemental.numberingSystems;
const full = {};
for (const dir of readdirSync(join(numbersDir, "main"))) {
  const main = readJson(join(numbersDir, "main", dir, "numbers.json")).main;
  const numbers = Object.values(main)[0].numbers;
  const system = numbers.defaultNumberingSystem;
  const digits = numberingSystems[system];
  if (digits?._type !== "numeric" || [...digits._digits].length !== 10) {
    throw new Error(`${dir}: the numbering system ${system} has no ten decimal digits.`);
  }
  const symbols = numbers[`symbols-numberSystem-${system}`];
  const pattern = numbers[`decimalFormats-numberSystem-${system}`]?.standard;
  if (typeof pattern !== "string" || !DECIMAL_PATTERN.test(pattern)) {
    throw new Error(`${dir}: the decimal pattern ${JSON.stringify(pattern)} is outside the subset the cores read.`);
  }
  for (const symbol of ["decimal", "group", "minusSign"]) {
    if (typeof symbols?.[symbol] !== "string" || symbols[symbol] === "") throw new Error(`${dir}: no ${symbol} symbol.`);
  }
  if (!/^[1-9]$/.test(numbers.minimumGroupingDigits)) throw new Error(`${dir}: minimumGroupingDigits is not a digit.`);
  full[rootName(dir)] = {
    digits: digits._digits,
    decimal: symbols.decimal,
    group: symbols.group,
    minusSign: symbols.minusSign,
    pattern,
    minimumGroupingDigits: numbers.minimumGroupingDigits,
  };
}
if (!full.root) throw new Error("cldr-numbers-full holds no root (und) locale.");

// Parent locales.
const parentLocales = readJson(join(coreDir, "supplemental", "parentLocales.json")).supplemental.parentLocales;
const mainParents = parentLocales.parentLocale;
const pluralParents = parentLocales.plurals ?? {};
if (parentLocales._localeRules?.parentLocale?.nonlikelyScript !== "root") {
  throw new Error("parentLocales no longer states the nonlikelyScript rule as a root parent.");
}
const likelySubtags = readJson(join(coreDir, "supplemental", "likelySubtags.json")).supplemental.likelySubtags;
const languages = new Set(Object.keys(full).map((tag) => tag.split("-")[0]).filter((language) => language !== "root"));
const likelyScripts = {};
for (const language of languages) {
  const likely = likelySubtags[language];
  if (likely === undefined) continue;
  const script = likely.split("-")[1];
  if (!/^[A-Z][a-z]{3}$/.test(script ?? "")) throw new Error(`${language}: no likely script in ${likely}.`);
  likelyScripts[language] = script;
}

/** The main component's parent: the explicit map, then the nonlikelyScript rule,
 *  then truncation; the root's parent is nothing. */
function mainParent(tag) {
  if (tag === "root") return undefined;
  if (mainParents[tag] !== undefined) return rootName(mainParents[tag]);
  const subtags = tag.split("-");
  if (subtags.length === 2 && /^[A-Za-z]{4}$/.test(subtags[1])) {
    const script = likelyScripts[subtags[0]];
    if (script === undefined || script.toLowerCase() !== subtags[1].toLowerCase()) return "root";
  }
  return subtags.length > 1 ? subtags.slice(0, -1).join("-") : "root";
}

const resolveIn = (table, tag) => {
  for (let at = tag; at !== undefined; at = mainParent(at)) if (table[at] !== undefined) return table[at];
  throw new Error(`${tag} resolves to nothing.`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const numbers = {};
for (const [tag, entry] of Object.entries(full)) {
  if (tag === "root" || !same(entry, resolveIn(full, mainParent(tag)))) numbers[tag] = entry;
}
for (const tag of Object.keys(full)) {
  if (!same(resolveIn(numbers, tag), full[tag])) throw new Error(`${tag} resolves differently once equal entries are omitted.`);
}

const files = {
  "plurals.json": { cldrVersion: CLDR_VERSION, rules: sorted(rules) },
  "numbers.json": { cldrVersion: CLDR_VERSION, locales: sorted(numbers) },
  "parent-locales.json": {
    cldrVersion: CLDR_VERSION,
    main: sorted(Object.fromEntries(Object.entries(mainParents).map(([k, v]) => [k, rootName(v)]))),
    plurals: sorted(Object.fromEntries(Object.entries(pluralParents).map(([k, v]) => [k, rootName(v)]))),
    likelyScripts: sorted(likelyScripts),
  },
};
const texts = Object.fromEntries(Object.entries(files).map(([name, value]) => [name, `${JSON.stringify(value, null, 2)}\n`]));
texts.LICENSE = license;

if (process.argv.includes("--check")) {
  const stale = Object.entries(texts).filter(
    ([name, text]) => !existsSync(join(OUT, name)) || readFileSync(join(OUT, name), "utf8") !== text,
  );
  if (stale.length > 0) {
    console.error(
      `message-format/cldr/ differs from CLDR ${CLDR_VERSION}: ${stale.map(([name]) => name).join(", ")}. ` +
        "Run `pnpm -C message-format/nodejs run generate:cldr`.",
    );
    process.exit(1);
  }
  console.log(`message-format/cldr/ is CLDR ${CLDR_VERSION}.`);
} else {
  for (const [name, text] of Object.entries(texts)) writeFileSync(join(OUT, name), text);
  console.log(
    `wrote message-format/cldr/ from CLDR ${CLDR_VERSION}: ${Object.keys(rules).length} plural rule sets, ` +
      `${Object.keys(numbers).length} of ${Object.keys(full).length} number entries.`,
  );
}
