#!/usr/bin/env node
/**
 * The controller protocol's completeness check.
 *
 * `kernel/specs/controller-protocol.md` and `sdk/controller-protocol/messages/`
 * are two halves of one contract: the spec says what an operation means, the
 * directory says what its payloads are. Either half can be edited without the
 * other, and a table that is wrong reads as authoritative — so this asserts they
 * agree, in both directions and character for character.
 *
 * This is the only reader of the spec's markdown anywhere in the repo, and it has
 * no write mode: a `--write` would be a generator by another name, and the
 * inventory table is part of a document a second implementer reads and trusts.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_PATH = "kernel/specs/controller-protocol.md";
const MESSAGES_DIR = "sdk/controller-protocol/messages";
const GENERATION_PATH = "sdk/controller-protocol/generation.json";
const DRAFT_07 = "http://json-schema.org/draft-07/schema#";
const INVENTORY_HEADING = "## 2. Message inventory";
const TABLE_HEADER = "| Message | Direction | Section | Synchronous | Reentrant |";
const TABLE_RULE = "| --- | --- | --- | --- | --- |";
const DIRECTIONS = ["kernel-to-controller", "controller-to-kernel", "either"];
const KEYS = ["name", "direction", "spec", "request", "response", "errors", "synchronous", "reentrant"];

const failures = [];
const fail = (message) => failures.push(message);

/** The file-name rule: the name lowercased, each `.` and each camel hump a `-`. */
const kebab = (name) =>
  name
    .split(".")
    .map((segment) => segment.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase())
    .join("-");

const renderRow = (entry) =>
  `| \`${entry.name}\` | \`${entry.direction}\` | \`${entry.spec}\` | ` +
  `${entry.synchronous ? "yes" : "no"} | ${entry.reentrant ? "yes" : "no"} |`;

// --- the message directory, as one set ordered by file name (UTF-8 bytes) ----

const messageFiles = readdirSync(join(repoRoot, MESSAGES_DIR))
  .filter((file) => file.endsWith(".json"))
  .sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));

if (messageFiles.length === 0) fail(`${MESSAGES_DIR}/ holds no message files.`);

const entries = [];
for (const file of messageFiles) {
  const path = `${MESSAGES_DIR}/${file}`;
  let entry;
  try {
    entry = JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
  } catch (error) {
    fail(`${path}: not readable as JSON — ${error.message}`);
    continue;
  }

  for (const key of KEYS) {
    if (!(key in entry)) fail(`${path}: missing the required key \`${key}\`.`);
  }
  for (const key of Object.keys(entry)) {
    if (!KEYS.includes(key)) {
      fail(`${path}: unknown key \`${key}\`. The entry keys are exactly ${KEYS.join(", ")}.`);
    }
  }
  if (typeof entry.name !== "string" || !/^[A-Z][A-Za-z]*\.[A-Z][A-Za-z]*$/.test(entry.name ?? "")) {
    fail(`${path}: \`name\` must be \`<Group>.<Operation>\` in PascalCase, not ${JSON.stringify(entry.name)}.`);
    continue;
  }
  if (!DIRECTIONS.includes(entry.direction)) {
    fail(`${path}: \`direction\` must be one of ${DIRECTIONS.join(", ")}, not ${JSON.stringify(entry.direction)}.`);
  }
  if (typeof entry.synchronous !== "boolean") fail(`${path}: \`synchronous\` must be a boolean.`);
  if (typeof entry.reentrant !== "boolean") fail(`${path}: \`reentrant\` must be a boolean.`);
  if (!Array.isArray(entry.errors) || entry.errors.some((code) => !/^ERR_[A-Z0-9_]+$/.test(code))) {
    fail(`${path}: \`errors\` must be a list of \`ERR_*\` codes.`);
  }

  // Rule 5 — the file name is the kebab spelling of the message's own name.
  const expectedFile = `${kebab(entry.name)}.json`;
  if (file !== expectedFile) {
    fail(`${path}: \`${entry.name}\` belongs in \`${MESSAGES_DIR}/${expectedFile}\`, not \`${file}\`.`);
  }

  // Rule 6 — one dialect, no resolver, no `format` assertion.
  for (const slot of ["request", "response"]) {
    const schema = entry[slot];
    if (schema === null || schema === undefined) continue;
    if (typeof schema !== "object" || Array.isArray(schema)) {
      fail(`${path}: \`${slot}\` must be a JSON Schema object, or null for a message with no response.`);
      continue;
    }
    if (schema.$schema !== DRAFT_07) {
      fail(
        `${path}: \`${slot}\` must declare "$schema": "${DRAFT_07}". ` +
          `Without it "validated against its schema" means a different thing to each validator.`,
      );
    }
    walkSchema(schema, `${path}#/${slot}`);
  }

  entries.push({ file, path, ...entry });
}

function walkSchema(node, where) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkSchema(item, `${where}/${index}`));
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref") {
      if (typeof value !== "string" || !value.startsWith("#/")) {
        fail(
          `${where}: \`$ref\` ${JSON.stringify(value)} leaves its own file. ` +
            `Every reference is internal, so a validator needs no resolver.`,
        );
      }
      continue;
    }
    if (key === "format") {
      fail(
        `${where}: \`format\` is not an assertion here — two validators disagree about it. ` +
          `Spell the constraint with \`pattern\`.`,
      );
      continue;
    }
    walkSchema(value, `${where}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
  }
}

// --- the spec ---------------------------------------------------------------

const specText = readFileSync(join(repoRoot, SPEC_PATH), "utf8");
const specLines = specText.split("\n");

const headings = new Set();
for (const line of specLines) {
  const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
  if (match) headings.add(match[1]);
}

// Rule 3 — every `spec` names a heading that exists.
for (const entry of entries) {
  if (typeof entry.spec !== "string" || !headings.has(entry.spec)) {
    fail(
      `${entry.path}: \`spec\` names ${JSON.stringify(entry.spec)}, which is no heading in ${SPEC_PATH}. ` +
        `Use the section heading's text exactly, without its leading \`#\`s.`,
    );
  }
}

// Rule 4 — every section §0 declares in scope is realised by some message.
const scopeMarker = specLines.findIndex((line) => line.startsWith("**In scope**"));
if (scopeMarker === -1) {
  fail(`${SPEC_PATH}: §0 carries no line starting with \`**In scope**\`, so the in-scope section list cannot be read.`);
} else {
  const inScope = [];
  for (let index = scopeMarker + 1; index < specLines.length; index += 1) {
    const line = specLines[index];
    if (line.trim() === "") continue;
    const item = /^-\s+`([^`]+)`/.exec(line);
    if (!item) break;
    inScope.push(item[1]);
  }
  if (inScope.length === 0) {
    fail(`${SPEC_PATH}: the \`**In scope**\` list is empty — each item is \`- \\\`<section heading>\\\` — …\`.`);
  }
  const claimed = new Set(entries.map((entry) => entry.spec));
  for (const section of inScope) {
    if (!headings.has(section)) {
      fail(`${SPEC_PATH}: §0 lists \`${section}\` as in scope, but no such heading exists in this spec.`);
    } else if (!claimed.has(section)) {
      fail(
        `${SPEC_PATH}: §0 lists \`${section}\` as in scope and no message realises it. ` +
          `Give some ${MESSAGES_DIR}/*.json a \`"spec": "${section}"\`, or take the section out of scope.`,
      );
    }
  }
}

// Rules 1 and 2 — the inventory table, row for row, in order.
const inventoryIndex = specLines.findIndex((line) => line.trim() === INVENTORY_HEADING);
if (inventoryIndex === -1) {
  fail(`${SPEC_PATH}: no \`${INVENTORY_HEADING}\` heading. The inventory table lives under it.`);
} else {
  const tableLines = [];
  for (let index = inventoryIndex + 1; index < specLines.length; index += 1) {
    const line = specLines[index].trim();
    if (line.startsWith("## ")) break;
    if (line.startsWith("|")) tableLines.push(line);
  }
  if (tableLines[0] !== TABLE_HEADER) {
    fail(`${SPEC_PATH}: the inventory table's header row must be exactly\n    ${TABLE_HEADER}\n  but is\n    ${tableLines[0] ?? "(absent)"}`);
  }
  if (tableLines[1] !== TABLE_RULE) {
    fail(`${SPEC_PATH}: the inventory table's separator row must be exactly\n    ${TABLE_RULE}\n  but is\n    ${tableLines[1] ?? "(absent)"}`);
  }
  const rows = tableLines.slice(2);
  const expected = entries.map(renderRow);

  // Name each side's surplus before the positional diff, so a missing file and a
  // missing row read as what they are rather than as a long reordering.
  const rowNames = new Map();
  for (const row of rows) {
    const match = /^\|\s*`([^`]+)`/.exec(row);
    if (match) rowNames.set(match[1], row);
  }
  const fileNames = new Set(entries.map((entry) => entry.name));
  for (const entry of entries) {
    if (!rowNames.has(entry.name)) {
      fail(
        `${SPEC_PATH}: \`${entry.name}\` (${entry.path}) has no row in the inventory. Add, in file order:\n    ${renderRow(entry)}`,
      );
    }
  }
  for (const name of rowNames.keys()) {
    if (!fileNames.has(name)) {
      fail(
        `${SPEC_PATH}: the inventory names \`${name}\`, and no ${MESSAGES_DIR}/${kebab(name)}.json exists. ` +
          `Add the message file, or drop the row.`,
      );
    }
  }

  const limit = Math.max(rows.length, expected.length);
  for (let index = 0; index < limit; index += 1) {
    if (rows[index] === expected[index]) continue;
    const owner = entries[index];
    fail(
      `${SPEC_PATH}: inventory row ${index + 1} does not match ${owner ? owner.path : "any message file"}.\n` +
        `  expected: ${expected[index] ?? "(no row — the inventory has more rows than there are messages)"}\n` +
        `  found:    ${rows[index] ?? "(no row — the inventory has fewer rows than there are messages)"}\n` +
        `  Rows run in the lexical order of the file names, compared as UTF-8 bytes.`,
    );
  }
}

// --- the generation counter -------------------------------------------------

let generation;
try {
  generation = JSON.parse(readFileSync(join(repoRoot, GENERATION_PATH), "utf8"));
} catch (error) {
  fail(`${GENERATION_PATH}: not readable as JSON — ${error.message}`);
}
if (generation !== undefined && !Number.isInteger(generation?.generation)) {
  fail(`${GENERATION_PATH}: must hold \`{ "generation": <integer> }\`.`);
}

// ----------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`The controller protocol's spec and message set disagree (${failures.length}):\n`);
  for (const failure of failures) console.error(`- ${failure}\n`);
  process.exit(1);
}

console.log(
  `controller protocol: ${entries.length} messages, inventory in agreement with ${SPEC_PATH} (generation ${generation.generation}).`,
);
