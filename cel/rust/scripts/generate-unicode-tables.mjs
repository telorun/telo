#!/usr/bin/env node
/**
 * Writes `cel/rust/src/unicode_tables.rs`, the engine's Unicode data, from the Unicode
 * Character Database 17.0.0.
 *
 * The archive is `UCD.zip`, pinned by its SHA-256 below and refused when it does not hash
 * to it, so the output is a function of the pin alone. Run it with no argument to fetch the
 * archive, or hand it a copy on disk:
 *
 *   node cel/rust/scripts/generate-unicode-tables.mjs [--archive <path to UCD.zip>]
 *
 * What it writes, and from which file:
 *
 * - the general categories, every two-letter value, the seven one-letter groups and `LC`
 *   (`UnicodeData.txt`, an unlisted code point being `Cn`);
 * - the scripts (`Scripts.txt`) and `Unknown`, every code point no script lists;
 * - the sixteen binary properties re2js 2.8.3 accepts (`PropList.txt`,
 *   `DerivedCoreProperties.txt`, `emoji/emoji-data.txt`);
 * - the simple case-folding orbit and, for every table above, the code points its fold
 *   closure adds (`CaseFolding.txt`, statuses `C` and `S`);
 * - the full lower- and upper-case mappings (`UnicodeData.txt` with the unconditional
 *   entries of `SpecialCasing.txt`) and the `Cased` and `Case_Ignorable` sets the
 *   Final_Sigma condition reads (`DerivedCoreProperties.txt`).
 *
 * The output is never edited by hand: change this script and run it again.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

export const UCD_VERSION = "17.0.0";
export const UCD_URL = "https://www.unicode.org/Public/17.0.0/ucd/UCD.zip";
export const UCD_SHA256 = "2066d1909b2ea93916ce092da1c0ee4808ea3ef8407c94b4f14f5b7eb263d28e";

const MAX_RUNE = 0x10ffff;

/** The binary properties re2js 2.8.3 resolves `\p{…}` against, with the file each is read from. */
const BINARY_PROPERTIES = {
  ASCII_Hex_Digit: "PropList.txt",
  Alphabetic: "DerivedCoreProperties.txt",
  Dash: "PropList.txt",
  Emoji: "emoji/emoji-data.txt",
  Emoji_Component: "emoji/emoji-data.txt",
  Emoji_Modifier: "emoji/emoji-data.txt",
  Emoji_Modifier_Base: "emoji/emoji-data.txt",
  Emoji_Presentation: "emoji/emoji-data.txt",
  Extended_Pictographic: "emoji/emoji-data.txt",
  Hex_Digit: "PropList.txt",
  Lowercase: "DerivedCoreProperties.txt",
  Math: "DerivedCoreProperties.txt",
  Quotation_Mark: "PropList.txt",
  Terminal_Punctuation: "PropList.txt",
  Uppercase: "DerivedCoreProperties.txt",
  White_Space: "PropList.txt",
};

const MAJOR_CATEGORIES = {
  C: ["Cc", "Cf", "Cn", "Co", "Cs"],
  L: ["Ll", "Lm", "Lo", "Lt", "Lu"],
  LC: ["Ll", "Lt", "Lu"],
  M: ["Mc", "Me", "Mn"],
  N: ["Nd", "Nl", "No"],
  P: ["Pc", "Pd", "Pe", "Pf", "Pi", "Po", "Ps"],
  S: ["Sc", "Sk", "Sm", "So"],
  Z: ["Zl", "Zp", "Zs"],
};

export const UCD_FILES = [
  "UnicodeData.txt",
  "Scripts.txt",
  "PropList.txt",
  "DerivedCoreProperties.txt",
  "emoji/emoji-data.txt",
  "CaseFolding.txt",
  "SpecialCasing.txt",
];

/** The Unicode License V3, which the data files are distributed under. */
const UNICODE_LICENSE = `UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.`;

// ---------------------------------------------------------------- the archive

async function readArchive(path) {
  if (path !== undefined) return readFileSync(path);
  const response = await fetch(UCD_URL);
  if (!response.ok) throw new Error(`fetching ${UCD_URL} answered ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

/** The named members of a zip archive, read through its central directory. */
export function unzip(archive, names) {
  let end = archive.length - 22;
  while (end >= 0 && archive.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("the archive has no end-of-central-directory record");
  const count = archive.readUInt16LE(end + 10);
  let entry = archive.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(entry) !== 0x02014b50) throw new Error("a central directory entry is malformed");
    const method = archive.readUInt16LE(entry + 10);
    const compressed = archive.readUInt32LE(entry + 20);
    const nameLength = archive.readUInt16LE(entry + 28);
    const extraLength = archive.readUInt16LE(entry + 30);
    const commentLength = archive.readUInt16LE(entry + 32);
    const local = archive.readUInt32LE(entry + 42);
    const name = archive.toString("utf8", entry + 46, entry + 46 + nameLength);
    if (names.includes(name)) {
      const dataStart = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
      const data = archive.subarray(dataStart, dataStart + compressed);
      if (method === 0) files.set(name, data.toString("utf8"));
      else if (method === 8) files.set(name, inflateRawSync(data).toString("utf8"));
      else throw new Error(`${name} is stored with compression method ${method}, which this reader does not read`);
    }
    entry += 46 + nameLength + extraLength + commentLength;
  }
  for (const name of names) if (!files.has(name)) throw new Error(`the archive holds no ${name}`);
  return files;
}

// ---------------------------------------------------------------- range sets

/** Sorted, disjoint, non-adjacent `[lo, hi]` pairs from a list of code points or pairs. */
function canonical(pairs) {
  const sorted = pairs.map(([lo, hi]) => [lo, hi]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

function complement(ranges) {
  const out = [];
  let next = 0;
  for (const [lo, hi] of ranges) {
    if (next < lo) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= MAX_RUNE) out.push([next, MAX_RUNE]);
  return out;
}

function contains(ranges, c) {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c < ranges[mid][0]) hi = mid;
    else if (c > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

// ---------------------------------------------------------------- the files

function dataLines(text) {
  const lines = [];
  for (const raw of text.split("\n")) {
    const line = raw.split("#")[0].trim();
    if (line !== "") lines.push(line.split(";").map((field) => field.trim()));
  }
  return lines;
}

function codeRange(field) {
  const [lo, hi] = field.split("..");
  return [parseInt(lo, 16), parseInt(hi ?? lo, 16)];
}

/** `name → pairs` for a `<range>; <value>` file, keeping the values asked for. */
function propertyFile(text, wanted) {
  const out = new Map();
  for (const [range, value] of dataLines(text)) {
    if (wanted !== undefined && !wanted.has(value)) continue;
    if (!out.has(value)) out.set(value, []);
    out.get(value).push(codeRange(range));
  }
  return out;
}

function generalCategories(text) {
  const byCategory = new Map();
  const add = (category, lo, hi) => {
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push([lo, hi]);
  };
  let first = null;
  for (const fields of dataLines(text)) {
    const code = parseInt(fields[0], 16);
    const name = fields[1];
    const category = fields[2];
    if (name.endsWith(", First>")) {
      first = code;
      continue;
    }
    if (name.endsWith(", Last>")) {
      add(category, first, code);
      first = null;
      continue;
    }
    add(category, code, code);
  }
  const tables = new Map();
  for (const [category, pairs] of byCategory) tables.set(category, canonical(pairs));
  const assigned = canonical([...byCategory.values()].flat());
  tables.set("Cn", complement(assigned));
  for (const [major, members] of Object.entries(MAJOR_CATEGORIES)) {
    tables.set(major, canonical(members.flatMap((member) => tables.get(member) ?? [])));
  }
  return tables;
}

function simpleCaseMappings(text) {
  const upper = new Map();
  const lower = new Map();
  for (const fields of dataLines(text)) {
    const code = parseInt(fields[0], 16);
    if (fields[12] !== "") upper.set(code, [parseInt(fields[12], 16)]);
    if (fields[13] !== "") lower.set(code, [parseInt(fields[13], 16)]);
  }
  return { upper, lower };
}

/** The full mappings: the simple ones, replaced by every unconditional `SpecialCasing.txt` entry. */
function fullCaseMappings(unicodeData, specialCasing) {
  const { upper, lower } = simpleCaseMappings(unicodeData);
  for (const fields of dataLines(specialCasing)) {
    const condition = fields[4] ?? "";
    if (condition !== "") continue;
    const code = parseInt(fields[0], 16);
    const codes = (text) => (text === "" ? [] : text.split(/\s+/).map((part) => parseInt(part, 16)));
    lower.set(code, codes(fields[1]));
    upper.set(code, codes(fields[3]));
  }
  const strip = (mappings) =>
    [...mappings]
      .filter(([code, to]) => !(to.length === 1 && to[0] === code))
      .sort((a, b) => a[0] - b[0]);
  return { lower: strip(lower), upper: strip(upper) };
}

/** Classes of code points equal under simple case folding (statuses `C` and `S`). */
function foldClasses(text) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) x = parent.get(x);
    return x;
  };
  for (const [code, status, mapping] of dataLines(text)) {
    if (status !== "C" && status !== "S") continue;
    const a = parseInt(code, 16);
    const b = parseInt(mapping, 16);
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const classes = new Map();
  for (const code of parent.keys()) {
    const root = find(code);
    if (!classes.has(root)) classes.set(root, []);
    classes.get(root).push(code);
  }
  return [...classes.values()].map((members) => members.sort((a, b) => a - b));
}

// ---------------------------------------------------------------- the tables

export function buildTables(files) {
  const categories = generalCategories(files.get("UnicodeData.txt"));
  for (const [name, file] of Object.entries(BINARY_PROPERTIES)) {
    const pairs = propertyFile(files.get(file), new Set([name])).get(name);
    if (pairs === undefined) throw new Error(`${file} lists no ${name}`);
    categories.set(name, canonical(pairs));
  }

  const scripts = new Map();
  for (const [name, pairs] of propertyFile(files.get("Scripts.txt"))) scripts.set(name, canonical(pairs));
  scripts.set("Unknown", complement(canonical([...scripts.values()].flat())));

  const classes = foldClasses(files.get("CaseFolding.txt"));
  const orbitOf = new Map();
  for (const members of classes) for (const member of members) orbitOf.set(member, members);
  const foldCodes = [...orbitOf.keys()];
  const minFold = Math.min(...foldCodes);
  const maxFold = Math.max(...foldCodes);

  // Each member of a class mapped to the next larger, the largest to the smallest. A class
  // of ASCII alone is left out: the casing fallback answers it, as re2js's table does.
  const orbit = [];
  for (const members of classes) {
    if (members.length < 2 || members.every((member) => member <= 0x7f)) continue;
    for (let i = 0; i < members.length; i++) orbit.push([members[i], members[(i + 1) % members.length]]);
  }
  orbit.sort((a, b) => a[0] - b[0]);

  /** What folding adds to a table: every code point outside it sharing a class with one inside. */
  const foldAdditions = (ranges) => {
    const added = [];
    for (const members of classes) {
      if (!members.some((member) => contains(ranges, member))) continue;
      for (const member of members) if (!contains(ranges, member)) added.push([member, member]);
    }
    return canonical(added);
  };
  const foldTables = (tables) => {
    const out = new Map();
    for (const [name, ranges] of tables) {
      const added = foldAdditions(ranges);
      if (added.length > 0) out.set(name, added);
    }
    return out;
  };

  const derived = propertyFile(files.get("DerivedCoreProperties.txt"), new Set(["Cased", "Case_Ignorable"]));
  const casing = fullCaseMappings(files.get("UnicodeData.txt"), files.get("SpecialCasing.txt"));

  return {
    categories,
    foldCategories: foldTables(categories),
    scripts,
    foldScripts: foldTables(scripts),
    orbit,
    minFold,
    maxFold,
    lower: casing.lower,
    upper: casing.upper,
    cased: canonical(derived.get("Cased")),
    caseIgnorable: canonical(derived.get("Case_Ignorable")),
  };
}

// ---------------------------------------------------------------- the Rust text

const hex = (code) => `0x${code.toString(16).toUpperCase()}`;

function rangeList(ranges) {
  const items = ranges.map(([lo, hi]) => `(${hex(lo)}, ${hex(hi)})`);
  const lines = [];
  for (let i = 0; i < items.length; i += 8) lines.push(`    ${items.slice(i, i + 8).join(", ")},`);
  return `&[\n${lines.join("\n")}\n]`;
}

function namedTables(constant, doc, tables) {
  const names = [...tables.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const entries = names.map((name) => `    (${JSON.stringify(name)}, ${rangeList(tables.get(name)).replace(/\n/g, "\n    ")}),`);
  return `/// ${doc}\npub(crate) static ${constant}: &[(&str, &[(u32, u32)])] = &[\n${entries.join("\n")}\n];\n`;
}

function mappingList(constant, doc, mappings) {
  const lines = mappings.map(([code, to]) => `    (${hex(code)}, &[${to.map(hex).join(", ")}]),`);
  return `/// ${doc}\npub(crate) static ${constant}: &[(u32, &[u32])] = &[\n${lines.join("\n")}\n];\n`;
}

export function rustSource(tables) {
  const notice = UNICODE_LICENSE.split("\n")
    .map((line) => (line === "" ? "//" : `// ${line}`))
    .join("\n");
  const orbitLines = [];
  const pairs = tables.orbit.map(([from, to]) => `(${hex(from)}, ${hex(to)})`);
  for (let i = 0; i < pairs.length; i += 8) orbitLines.push(`    ${pairs.slice(i, i + 8).join(", ")},`);
  return `//! The engine's Unicode data — Unicode ${UCD_VERSION}. No Node twin: Node's tables are V8's
//! and re2js's own.
//!
//! GENERATED by \`cel/rust/scripts/generate-unicode-tables.mjs\` from the Unicode Character
//! Database archive \`UCD.zip\` ${UCD_VERSION}, SHA-256 \`${UCD_SHA256}\`.
//! Never edit it by hand: change the script and run it again.
//!
//! Every table of ranges is sorted, its ranges disjoint and never adjacent. A name table is
//! sorted by name, byte by byte.

// The data is derived from the Unicode Character Database, distributed under this notice:
//
${notice}

/// The Unicode version every table here is read from.
pub(crate) const UNICODE_VERSION: &str = ${JSON.stringify(UCD_VERSION)};

/// The smallest and largest code point simple case folding relates to another.
pub(crate) const MIN_FOLD: u32 = ${hex(tables.minFold)};
pub(crate) const MAX_FOLD: u32 = ${hex(tables.maxFold)};

${namedTables("CATEGORY_TABLES", "The general categories, \`LC\` and the binary properties, by name.", tables.categories)}
${namedTables("FOLD_CATEGORY_TABLES", "What simple case folding adds to each of `CATEGORY_TABLES`, where it adds anything.", tables.foldCategories)}
${namedTables("SCRIPT_TABLES", "The scripts, and `Unknown`, by name.", tables.scripts)}
${namedTables("FOLD_SCRIPT_TABLES", "What simple case folding adds to each of `SCRIPT_TABLES`, where it adds anything.", tables.foldScripts)}
/// The simple case-folding orbit: each code point of a class of two or more, mapped to the
/// next larger of its class and the largest to the smallest. A class of ASCII alone is not here.
pub(crate) static CASE_ORBIT: &[(u32, u32)] = &[
${orbitLines.join("\n")}
];

${mappingList("LOWERCASE_MAPPINGS", "The full lowercase mapping of each code point it changes, Final_Sigma aside.", tables.lower)}
${mappingList("UPPERCASE_MAPPINGS", "The full uppercase mapping of each code point it changes.", tables.upper)}
/// The \`Cased\` property, read by the Final_Sigma condition.
pub(crate) static CASED: &[(u32, u32)] = ${rangeList(tables.cased)};

/// The \`Case_Ignorable\` property, read by the Final_Sigma condition.
pub(crate) static CASE_IGNORABLE: &[(u32, u32)] = ${rangeList(tables.caseIgnorable)};
`;
}

async function main() {
  const argv = process.argv.slice(2);
  const archiveFlag = argv.indexOf("--archive");
  const archive = await readArchive(archiveFlag >= 0 ? argv[archiveFlag + 1] : undefined);
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== UCD_SHA256) throw new Error(`the archive hashes to ${digest}, and the pin is ${UCD_SHA256}`);
  const tables = buildTables(unzip(archive, UCD_FILES));
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "unicode_tables.rs");
  writeFileSync(out, rustSource(tables));
  process.stdout.write(`wrote ${out}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exit(1);
  });
}
