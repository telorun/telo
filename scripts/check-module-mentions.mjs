#!/usr/bin/env node
/**
 * The module-blindness check.
 *
 * The analyzer and the kernel must never know a module: every resource-specific
 * behaviour is expressed through `x-telo-*` annotations and resolved generically.
 * A comment or an example naming a standard-library kind is how that knowledge
 * starts, so this check is text-based and reads comments as code. It fails on:
 *
 * - a module kind: `<Name>.<Kind>`, where `<Name>` is the module's own name or an
 *   alias some manifest imports it under, and `<Kind>` is one of its kinds;
 * - a module name inside an identifier or a word, in any case or separator
 *   spelling (`http-server`, `HttpServer`, `HTTP_SERVER`, `better_sqlite3`),
 *   except the names in `GENERIC_NAMES`;
 * - a module path: `modules/<dir>` or `@telorun/<dir>`, generic names included.
 *
 * The vocabulary is read from `modules/` on every run, so a new module is covered
 * by being added. Tests are out of scope: they drive modules legitimately.
 *
 * Also imported by `.claude/hooks/module-mentions.mjs`, which checks the text an
 * edit writes against a cached vocabulary.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

const scriptPath = fileURLToPath(import.meta.url);
export const repoRoot = join(dirname(scriptPath), "..");

export const SCOPE = [
  "analyzer/nodejs/src",
  "analyzer/rust/src",
  "analyzer/migrations",
  "kernel/nodejs/src",
  "kernel/rust/src",
  "sdk/builtins",
  "sdk/error-codes",
  "sdk/formats",
  "sdk/translations",
  "sdk/value-types",
  "sdk/zone-attributes",
];

/**
 * Module names that are also the generic word for a concept the core owns, so
 * a bare mention says nothing about the module. Their kinds and paths are still
 * refused. Compared in normalized form: lower case, separators removed.
 */
const GENERIC_NAMES = new Set([
  "ai", "apikey", "app", "assert", "auth", "blob", "broadcast", "cache", "channel",
  "codec", "collection", "config", "console", "container", "crud", "crypto", "data",
  "datamodel", "desktop", "dev", "docker", "domain", "durable", "embedding",
  "filesystem", "font", "fs", "graph", "gzip", "html", "idempotency", "identity",
  "image", "javascript", "lease", "log", "mediatype", "openai", "otlp", "pdf",
  "postgres", "protection", "queue", "queues", "recordstream", "run", "scheduler",
  "session", "shell", "sql", "sqlite", "stream", "tar", "test", "timer", "type", "ui",
  "watch", "yaml",
]);

const NOT_A_MODULE_FILE = /(^|\/)(tests|__fixtures__|example)\//;
const NOT_AN_ALIAS_SOURCE = /(^|\/)(tests|__fixtures__|[\w-]+-conformance)\//;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TELO_DOCUMENT = /^kind: *Telo\./m;
const CACHE_FILE = join(repoRoot, "node_modules/.cache/check-module-mentions.json");

/** Whether a repository-relative path is one this check reads. */
export const inScope = (file) =>
  SCOPE.some((root) => file === root || file.startsWith(`${root}/`));

const git = (...args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\n")
    .filter(Boolean);

const trackedFiles = () => git("ls-files", "--cached", "--others", "--exclude-standard");
const manifestFiles = (tracked) => tracked.filter((file) => /\.ya?ml$/.test(file));

const normalize = (name) => name.toLowerCase().replace(/[-_]/g, "");

/** The documents of a YAML file. A file that is not Telo YAML (a chart template) is skipped. */
function readDocuments(file) {
  const text = readFileSync(join(repoRoot, file), "utf8");
  if (!TELO_DOCUMENT.test(text)) return [];
  const documents = parseAllDocuments(text);
  const broken = documents.find((doc) => doc.errors.length > 0);
  if (broken) {
    throw new Error(`${file}: cannot read the module vocabulary: ${broken.errors[0].message}`);
  }
  return documents
    .map((doc) => doc.toJS({ mapAsMap: false }))
    .filter((doc) => doc && typeof doc === "object");
}

/**
 * `modules/<dir>` → `names`, the prefixes its kinds are written under (every
 * module doc's name and every alias it is imported under), `rootName`, the name
 * its own `telo.yaml` declares, and `kinds`.
 */
function buildVocabulary(manifests) {
  const modules = new Map();
  for (const file of manifests) {
    const match = file.match(/^modules\/([^/]+)\//);
    if (!match || NOT_A_MODULE_FILE.test(file)) continue;
    const entry = modules.get(match[1]) ?? { names: new Set(), kinds: new Set(), rootName: null };
    modules.set(match[1], entry);
    for (const doc of readDocuments(file)) {
      const name = doc.metadata?.name;
      if (typeof name !== "string") continue;
      if (doc.kind === "Telo.Library" || doc.kind === "Telo.Application") {
        entry.names.add(name);
        if (file === `modules/${match[1]}/telo.yaml`) entry.rootName = name;
      }
      if (["Telo.Definition", "Telo.Abstract", "Telo.NeedType"].includes(doc.kind)) {
        entry.kinds.add(name);
      }
    }
  }

  const modulesRoot = join(repoRoot, "modules");
  for (const file of manifests) {
    if (NOT_AN_ALIAS_SOURCE.test(file)) continue;
    for (const doc of readDocuments(file)) {
      if (!doc.imports || typeof doc.imports !== "object") continue;
      for (const [alias, value] of Object.entries(doc.imports)) {
        const source = typeof value === "string" ? value : value?.source;
        if (typeof source !== "string" || !NAME.test(alias)) continue;
        const published = source.match(/\/telorun\/([a-z0-9-]+)@/);
        const local = /^\.{1,2}\//.test(source)
          ? relative(modulesRoot, resolve(repoRoot, dirname(file), source)).split(sep)[0]
          : undefined;
        modules.get(published?.[1] ?? local)?.names.add(alias);
      }
    }
  }

  return Object.fromEntries(
    [...modules].map(([dir, { names, kinds, rootName }]) => [
      dir,
      { names: [...names].sort(), kinds: [...kinds].sort(), rootName },
    ]),
  );
}

/**
 * The vocabulary, from `modules/` and every manifest's `imports:`. With `cache`,
 * reused while no manifest and not this script changed since it was written.
 */
export function loadVocabulary({ cache = false } = {}) {
  const manifests = manifestFiles(trackedFiles());
  if (!cache) return buildVocabulary(manifests);
  const hash = createHash("sha256").update(readFileSync(scriptPath));
  for (const file of manifests) {
    const stat = statSync(join(repoRoot, file), { throwIfNoEntry: false });
    hash.update(`${file}\0${stat?.mtimeMs ?? "-"}\0${stat?.size ?? "-"}\n`);
  }
  const key = hash.digest("hex");
  const cached = (() => {
    try {
      return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  })();
  if (cached?.key === key) return cached.vocabulary;
  const vocabulary = buildVocabulary(manifests);
  mkdirSync(dirname(CACHE_FILE), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify({ key, vocabulary }));
  return vocabulary;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const longestFirst = (a, b) => b.length - a.length;

/** An identifier or word, split at separators and case changes. */
const IDENTIFIER = /[A-Za-z0-9][A-Za-z0-9_-]*/g;
const TOKEN = /[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z]+|[0-9]+/g;

/** A matcher over the vocabulary: text → `{ line, column, what }` per mention (1-based). */
export function createMatcher(vocabulary) {
  const entries = Object.entries(vocabulary);

  const kindAlternatives = [];
  for (const [, { names, kinds }] of entries) {
    if (names.length === 0 || kinds.length === 0) continue;
    const prefixes = [...names].sort(longestFirst).map(escape).join("|");
    const suffixes = [...kinds].sort(longestFirst).map(escape).join("|");
    kindAlternatives.push(`(?:${prefixes})\\.(?:${suffixes})`);
  }
  const kindMention = new RegExp(`(?<![\\w.])(?:${kindAlternatives.join("|")})(?!\\w)`, "g");

  const dirs = entries.map(([dir]) => dir).sort(longestFirst).map(escape).join("|");
  const pathMention = new RegExp(`(?:\\bmodules/|@telorun/)(?:${dirs})(?![\\w-])`, "g");

  /** Normalized module name → the module directory it belongs to. */
  const bareNames = new Map();
  for (const [dir, { rootName }] of entries) {
    for (const name of rootName ? [dir, rootName] : [dir]) {
      const key = normalize(name);
      if (!GENERIC_NAMES.has(key) && !bareNames.has(key)) bareNames.set(key, dir);
    }
  }
  const longestBareName = Math.max(...[...bareNames.keys()].map((key) => key.length));

  function* bareMentions(line) {
    for (const word of line.matchAll(IDENTIFIER)) {
      const tokens = [...word[0].matchAll(TOKEN)].map((token) => ({
        text: token[0].toLowerCase(),
        start: word.index + token.index,
        end: word.index + token.index + token[0].length,
      }));
      for (let i = 0; i < tokens.length; i++) {
        let found;
        let joined = "";
        for (let j = i; j < tokens.length && joined.length < longestBareName; j++) {
          joined += tokens[j].text;
          if (bareNames.has(joined)) found = { j, joined };
        }
        if (!found) continue;
        yield {
          column: tokens[i].start,
          text: line.slice(tokens[i].start, tokens[found.j].end),
          module: bareNames.get(found.joined),
        };
        i = found.j;
      }
    }
  }

  return (text) => {
    const mentions = [];
    text.split("\n").forEach((line, index) => {
      const at = (column, what) => mentions.push({ line: index + 1, column: column + 1, what });
      const reported = [];
      for (const [pattern, label] of [[kindMention, "kind"], [pathMention, "path"]]) {
        for (const match of line.matchAll(pattern)) {
          reported.push([match.index, match.index + match[0].length]);
          at(match.index, `module ${label} \`${match[0]}\``);
        }
      }
      for (const mention of bareMentions(line)) {
        const end = mention.column + mention.text.length;
        if (reported.some(([from, to]) => mention.column >= from && end <= to)) continue;
        at(mention.column, `module name \`${mention.text}\` (modules/${mention.module})`);
      }
    });
    return mentions;
  };
}

export const REMEDY =
  "The analyzer and the kernel MUST NOT know any module: describe the behaviour through its" +
  " annotation or capability. Do not reference any specific module.";

function main() {
  const tracked = trackedFiles();
  const findMentions = createMatcher(buildVocabulary(manifestFiles(tracked)));
  const findings = [];
  const scoped = tracked.filter(inScope);
  for (const file of scoped) {
    for (const { line, column, what } of findMentions(readFileSync(join(repoRoot, file), "utf8"))) {
      findings.push(`${file}:${line}:${column}: ${what}`);
    }
  }
  if (findings.length > 0) {
    for (const finding of findings) console.error(finding);
    console.error(`\n${findings.length} mention(s) of a module in ${SCOPE.join(", ")}.\n${REMEDY}`);
    process.exit(1);
  }
  console.log(`No module mentioned in ${scoped.length} files.`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) main();
