#!/usr/bin/env node
// Derives the built-in vocabulary from `sdk/builtins/` into `@telorun/analyzer`'s
// source tree.
//
// The entries are canonical at `sdk/builtins/` — one JSON file per built-in
// document, and one per shared schema fragment under `fragments/` — because both
// analyzers, both kernels and the editor support read the same vocabulary, and a
// copy written as one language's code would be a second vocabulary.
//
// Two fields are DERIVED rather than written: a source entry marks a list with
// `{ "$roster": "declarable" | "throwsAllowed" }`, and this script replaces it with
// the lexically sorted names of the capability roster entries whose flag is true.
// The roster is the built-in `Telo.Abstract` entries carrying `declarable`; a
// role is one whose own `capability:` names itself. Every other field is copied
// unchanged, so the derived entry is the source entry with its markers resolved.
//
// From the same derivation it renders the ARCHIVE — the `Telo.Builtins` YAML
// stream `kernel/specs/builtin-vocabulary.md` specifies, the bytes a telo release
// publishes as `oci://ghcr.io/telorun/telo@<version>` — into
// `analyzer/nodejs/src/builtin-vocabulary/`: `builtins.yaml`, a byte copy of
// `sdk/LICENSE` beside it, and `index.ts` exporting the same bytes as
// `BUILTIN_VOCABULARY_ARCHIVE`. The archive's version is the identity
// `version-line.mjs` computes for this tree (`X`, or `X+unreleased` while a line
// changeset is pending). Its YAML comes from the fixed emitter below, never from a
// library, so the bytes depend on nothing installed. Beside them it writes
// `analyzer/nodejs/builtin-vocabulary-slices.json`: every name `telo builtins`
// selects with the exact text it must print, recorded as the archive is emitted —
// the expectation both CLIs' slicers are tested against.
//
// Dependency-free, so it runs wherever nothing is installed or built: the root
// `prepare`, `@telorun/analyzer`'s own `prepare` and `prepack`, and the CI job
// that builds the Rust CLI all run it. Every destination is gitignored; the repo
// holds one copy of each entry.
//
// Usage: node scripts/render-builtin-vocabulary.mjs

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { teloGeneration } from "./version-line.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "sdk", "builtins");
const FRAGMENT_SRC = join(SRC, "fragments");
const DEST = join(ROOT, "analyzer", "nodejs", "src", "builtin-entries");
const ARCHIVE_DEST = join(ROOT, "analyzer", "nodejs", "src", "builtin-vocabulary");
const SLICES_DEST = join(ROOT, "analyzer", "nodejs", "builtin-vocabulary-slices.json");
const SECTION_SRC = {
  valueTypes: join(ROOT, "sdk", "value-types"),
  zoneAttributes: join(ROOT, "sdk", "zone-attributes"),
  formats: join(ROOT, "sdk", "formats"),
  errorCodes: join(ROOT, "sdk", "error-codes"),
};
const LICENSE_SRC = join(ROOT, "sdk", "LICENSE");

const MARKER = "$roster";
const ROSTER_FLAGS = ["declarable", "throwsAllowed"];

function fail(message) {
  console.error(`render-builtin-vocabulary: ${message}`);
  process.exit(1);
}

// A missing source directory is a packaging mistake: a build shipping no
// built-ins would register no `Telo.*` kind at all.
for (const path of [SRC, FRAGMENT_SRC, ...Object.values(SECTION_SRC), LICENSE_SRC]) {
  if (!existsSync(path)) {
    fail(
      `'${path}' does not exist. The built-in vocabulary is data that ships beside the ` +
        `language halves — if this is a container or package build, its file allowlist ` +
        `has to include 'sdk/builtins', 'sdk/value-types', 'sdk/zone-attributes', ` +
        `'sdk/formats', 'sdk/error-codes' and 'sdk/LICENSE'.`,
    );
  }
}

function readEntries(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const text = readFileSync(join(dir, file), "utf8");
      try {
        return { file, data: JSON.parse(text) };
      } catch (err) {
        fail(`${join(dir, file)} is not JSON: ${err instanceof Error ? err.message : err}`);
      }
    });
}

const documents = readEntries(SRC);
const fragments = readEntries(FRAGMENT_SRC);

for (const { file, data } of documents) {
  const name = data?.metadata?.name;
  if (`${name}.json` !== file) {
    fail(`sdk/builtins/${file}: an entry is named by its metadata.name ('${name}.json').`);
  }
}

// The roster: built-in abstracts carrying `declarable`. Read from the entries
// alone, never from anything a module declares.
const roster = documents
  .map(({ data }) => data)
  .filter((data) => data.kind === "Telo.Abstract" && Object.hasOwn(data, "declarable"));
const roleName = (data) => `Telo.${data.metadata.name}`;
const isRole = (data) => data.capability === roleName(data);

function derivedList(flag, where) {
  if (!ROSTER_FLAGS.includes(flag)) {
    fail(`${where}: '${MARKER}: ${JSON.stringify(flag)}' — the flags are ${ROSTER_FLAGS.join(", ")}.`);
  }
  return roster
    .filter((data) => isRole(data) && data[flag] === true)
    .map(roleName)
    .sort();
}

/** Replace every `{ "$roster": <flag> }` value with the roster names it derives. */
function derive(node, where) {
  if (Array.isArray(node)) return node.map((item, i) => derive(item, `${where}[${i}]`));
  if (!node || typeof node !== "object") return node;
  if (Object.hasOwn(node, MARKER)) {
    if (Object.keys(node).length !== 1) {
      fail(`${where}: a '${MARKER}' marker stands alone in place of a list.`);
    }
    return derivedList(node[MARKER], where);
  }
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, derive(value, `${where}.${key}`)]),
  );
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });

// The derived data is written as literals rather than imported as JSON modules:
// a loader's JSON interop is not one behaviour — under jiti's `interopDefault`
// (how Docusaurus loads its config) an entry with a top-level `default` key, as
// `RetryAttempts` has, comes back holding itself under `default`.
const literal = (data) => JSON.stringify(data, null, 2).replace(/\n/g, "\n  ");
const documentTuples = documents
  .map(({ file, data }) => `  ["${file}", ${literal(derive(data, file))}],`)
  .join("\n");
const fragmentTuples = fragments
  .map(
    ({ file, data }) =>
      `  ["${file.slice(0, -".json".length)}", ${literal(derive(data, `fragments/${file}`))}],`,
  )
  .join("\n");

writeFileSync(
  join(DEST, "index.ts"),
  `// GENERATED by scripts/render-builtin-vocabulary.mjs — do not edit, and do not commit.
// Source: sdk/builtins/*.json and sdk/builtins/fragments/*.json (lexically ordered),
// with every \`$roster\` marker derived.

/** Every built-in document, by file, in lexical order. */
export const BUILTIN_DOCUMENT_FILES: ReadonlyArray<readonly [file: string, data: unknown]> = [
${documentTuples}
];

/** Every shared schema fragment, by name, in lexical order. */
export const BUILTIN_FRAGMENT_FILES: ReadonlyArray<readonly [name: string, data: unknown]> = [
${fragmentTuples}
];
`,
  "utf8",
);

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

/** What the root document says about the vocabulary itself. The description is
 *  hub search text, under the root CLAUDE.md's description rules. */
const ROOT_DESCRIPTION =
  "Everything a Telo manifest can use without an import, for one telo release: the " +
  "documents that declare applications, libraries, kinds, imports and needs; the lifecycle " +
  "roles a kind may take; log and trace destinations; named schema shapes and CEL " +
  "functions; public address needs; and the schema fragments, value types, zone " +
  "attributes and string formats they reference; and the error codes the runtime raises " +
  "itself, with the text a person is shown for each.";

/**
 * The fixed YAML emitter. Block style, two-space indent, LF, no anchors, tags or
 * comments; keys in the order given. A string is written plain only when it
 * matches one conservative rule — a letter, `_` or `$`, then letters, digits and
 * `_ $ . / -`, and not a word any YAML schema reads as a boolean or null — and
 * as a JSON string otherwise, which every YAML 1.2 reader reads back as the same
 * text. An empty map or list is written `{}` / `[]`. No line is ever folded, so
 * a value is always one line and a block's extent is its indentation.
 */
const PLAIN = /^[A-Za-z_$][A-Za-z0-9_$./-]*$/;
const NOT_PLAIN = /^(?:true|false|null|yes|no|on|off|y|n|~)$/i;

const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function scalarText(value, where) {
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${where}: ${value} has no YAML spelling.`);
    return String(value);
  }
  if (typeof value === "string") {
    return PLAIN.test(value) && !NOT_PLAIN.test(value) ? value : JSON.stringify(value);
  }
  fail(`${where}: a ${typeof value} is not JSON data.`);
}

function inlineText(value, where) {
  if (Array.isArray(value)) return "[]";
  if (isMap(value)) return "{}";
  return scalarText(value, where);
}

const nonEmpty = (value) =>
  Array.isArray(value) ? value.length > 0 : isMap(value) && Object.keys(value).length > 0;

function mappingLines(map, indent, where) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (const [key, value] of Object.entries(map)) {
    const at = `${where}.${key}`;
    const head = `${pad}${scalarText(key, at)}:`;
    if (nonEmpty(value)) {
      lines.push(head, ...blockLines(value, indent + 2, at));
    } else {
      lines.push(`${head} ${inlineText(value, at)}`);
    }
  }
  return lines;
}

function sequenceLines(list, indent, where) {
  const pad = " ".repeat(indent);
  const lines = [];
  list.forEach((item, i) => {
    const at = `${where}[${i}]`;
    if (isMap(item) && nonEmpty(item)) {
      const inner = mappingLines(item, indent + 2, at);
      inner[0] = `${pad}- ${inner[0].slice(indent + 2)}`;
      lines.push(...inner);
    } else if (Array.isArray(item) && nonEmpty(item)) {
      lines.push(`${pad}-`, ...sequenceLines(item, indent + 2, at));
    } else {
      lines.push(`${pad}- ${inlineText(item, at)}`);
    }
  });
  return lines;
}

function blockLines(value, indent, where) {
  return Array.isArray(value) ? sequenceLines(value, indent, where) : mappingLines(value, indent, where);
}

const text = (lines) => `${lines.join("\n")}\n`;

/** One section of the root document: its entries keyed by name (an error
 *  code's by its `code`), lexically. Each entry is its data file verbatim. */
function readSection(section, dir, key = "name") {
  const entries = {};
  for (const { file, data } of readEntries(dir)) {
    const name = data?.[key];
    if (typeof name !== "string" || name === "") {
      fail(`${dir}/${file}: an entry of '${section}' declares no string '${key}'.`);
    }
    if (Object.hasOwn(entries, name)) fail(`${dir}/${file}: '${section}' declares '${name}' twice.`);
    entries[name] = data;
  }
  return entries;
}

function sortedByKey(map) {
  return Object.fromEntries(Object.keys(map).sort().map((key) => [key, map[key]]));
}

const derivedFragments = Object.fromEntries(
  fragments.map(({ file, data }) => [file.slice(0, -".json".length), derive(data, `fragments/${file}`)]),
);
const sections = {
  $defs: sortedByKey(derivedFragments),
  valueTypes: sortedByKey(readSection("valueTypes", SECTION_SRC.valueTypes)),
  zoneAttributes: sortedByKey(readSection("zoneAttributes", SECTION_SRC.zoneAttributes)),
  formats: sortedByKey(readSection("formats", SECTION_SRC.formats)),
  errorCodes: sortedByKey(readSection("errorCodes", SECTION_SRC.errorCodes, "code")),
};

let version;
try {
  version = teloGeneration().identity;
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

/** Every selectable entry, in archive order: the names that select it and the
 *  exact text `telo builtins` prints for it. */
const selectable = [];

const rootLines = mappingLines(
  {
    kind: "Telo.Builtins",
    metadata: { name: "Telo", version, description: ROOT_DESCRIPTION, license: "MIT" },
  },
  0,
  "root",
);
const SECTION_CLASS = {
  $defs: "fragment",
  valueTypes: "value type",
  zoneAttributes: "zone attribute",
  formats: "format",
  errorCodes: "error code",
};
for (const [section, entries] of Object.entries(sections)) {
  const head = `${scalarText(section, "root")}:`;
  if (Object.keys(entries).length === 0) {
    rootLines.push(`${head} {}`);
    continue;
  }
  rootLines.push(head);
  for (const [name, value] of Object.entries(entries)) {
    if (!nonEmpty(value) || !isMap(value)) {
      fail(`${section}.${name}: an entry is a non-empty map, so its block is its indentation.`);
    }
    const block = mappingLines({ [name]: value }, 2, section);
    rootLines.push(...block);
    selectable.push({ class: SECTION_CLASS[section], names: [name], text: text([head, ...block]) });
  }
}

const documentTexts = [text(rootLines)];
for (const { file, data } of documents) {
  const derived = derive(data, file);
  const keys = Object.keys(derived);
  if (keys[0] !== "kind" || keys[1] !== "metadata" || Object.keys(derived.metadata)[0] !== "name") {
    fail(
      `sdk/builtins/${file}: a document starts with 'kind', then 'metadata' with 'name' first — ` +
        `that prefix is how a reader of the archive finds a document's identity.`,
    );
  }
  const documentText = text(mappingLines(derived, 0, file));
  documentTexts.push(documentText);
  const name = derived.metadata.name;
  selectable.push({ class: "kind", names: [name, `Telo.${name}`], text: documentText });
}
const archive = documentTexts.join("---\n");

// One name selects one entry: a name two entries answer to would make what
// `telo builtins <name>` prints depend on lookup order.
const owners = new Map();
for (const entry of selectable) {
  for (const name of entry.names) {
    const other = owners.get(name);
    if (other) {
      fail(
        `the name '${name}' selects both the ${other.class} '${other.names[0]}' and the ` +
          `${entry.class} '${entry.names[0]}'. Rename one: every name of the vocabulary selects one entry.`,
      );
    }
    owners.set(name, entry);
  }
}

/** Write only what changed, so a no-op run leaves every mtime alone — the Rust
 *  CLI's build script re-runs on a change to the archive. */
function writeIfChanged(path, content) {
  if (existsSync(path) && readFileSync(path).equals(Buffer.from(content))) return;
  writeFileSync(path, content);
}

mkdirSync(ARCHIVE_DEST, { recursive: true });
writeIfChanged(join(ARCHIVE_DEST, "builtins.yaml"), archive);
writeIfChanged(join(ARCHIVE_DEST, "LICENSE"), readFileSync(LICENSE_SRC));
writeIfChanged(
  join(ARCHIVE_DEST, "index.ts"),
  `// GENERATED by scripts/render-builtin-vocabulary.mjs — do not edit, and do not commit.

/** The built-in vocabulary this build implements, byte for byte the
 *  \`builtins.yaml\` beside this module: the \`Telo.Builtins\` archive of telo
 *  ${version}. */
export const BUILTIN_VOCABULARY_ARCHIVE: string = ${JSON.stringify(archive)};
`,
);
writeIfChanged(
  SLICES_DEST,
  `${JSON.stringify(
    {
      $comment:
        "GENERATED by scripts/render-builtin-vocabulary.mjs from the archive it emitted: every selectable entry, the names selecting it and the exact text `telo builtins <name>` prints. Both CLIs' slicers are tested against it.",
      entries: selectable,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `render-builtin-vocabulary: ${documents.length} documents, ${fragments.length} fragments → ` +
    `analyzer/nodejs/src/builtin-entries/; archive ${version} → analyzer/nodejs/src/builtin-vocabulary/`,
);
