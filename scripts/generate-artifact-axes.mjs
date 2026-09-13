#!/usr/bin/env node
// Generates `analyzer/nodejs/src/artifact-axes.ts` — the selector axis vocabulary
// of `kernel/specs/module-artifact.md` §2, from `analyzer/artifact-axes/axes.json`.
//
// The vocabulary is data because every kernel must agree on it: a published
// layer index is read by all of them, and an axis one kernel knows and another
// does not changes which layers each skips. JSON is the form both the Node and
// the Rust half can read.
//
// ORDER IS PART OF THE CONTRACT: release ledger keys (`layerDigestKey`) render
// axes in this order, so a new axis is appended and existing ones never move.
//
// Generated rather than copied (the `generate-telo-version.mjs` precedent, not
// `copy-value-type-entries.mjs`): a JSON import types as `string[]`, while the
// selector model indexes by a literal axis union, which only an `as const`
// literal preserves.
//
// Runs from BOTH the root `prepare` (pnpm, fresh clone) and the analyzer's own
// `prepare` (npm, before pack), for the reason `generate-telo-version.mjs` gives.
// The destination is gitignored AND must stay untracked, or it becomes a second
// place the vocabulary lives.
//
// Usage: node scripts/generate-artifact-axes.mjs

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "analyzer", "artifact-axes", "axes.json");
const DEST = join(ROOT, "analyzer", "nodejs", "src", "artifact-axes.ts");

const ENTRY_KEYS = new Set(["name", "description", "valueForm"]);
const VALUE_FORM_KEYS = new Set(["pattern", "form", "examples"]);
const AXIS_NAME = /^[a-z][a-z0-9_]*$/;

function fail(detail) {
  console.error(`generate-artifact-axes: ${SOURCE}: ${detail}`);
  process.exit(1);
}

// A missing or malformed source is a packaging mistake, never a reason to emit a
// placeholder: an empty axis set would read every platform-constrained layer as
// carrying an unknown axis and skip it.
if (!existsSync(SOURCE)) {
  fail("does not exist. The selector axis vocabulary is read from it.");
}

let axes;
try {
  axes = JSON.parse(readFileSync(SOURCE, "utf8"));
} catch (err) {
  fail(`is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
}

if (!Array.isArray(axes) || axes.length === 0) {
  fail("expected a non-empty array of axis entries.");
}

const seen = new Set();
const valueForms = [];
axes.forEach((entry, index) => {
  const at = `entry ${index}`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    fail(`${at}: expected an object.`);
  }
  const unknown = Object.keys(entry).filter((key) => !ENTRY_KEYS.has(key));
  if (unknown.length > 0) {
    fail(`${at}: unknown key(s) ${unknown.join(", ")}. Known: ${[...ENTRY_KEYS].join(", ")}.`);
  }
  const { name, description, valueForm } = entry;
  if (typeof name !== "string" || !AXIS_NAME.test(name)) {
    fail(`${at}: 'name' must match ${AXIS_NAME}, got ${JSON.stringify(name)}.`);
  }
  // `format` is the selector's required leading field, not an optional axis.
  if (name === "format") fail(`${at}: 'format' is not an axis.`);
  if (seen.has(name)) fail(`${at}: axis '${name}' is declared twice.`);
  seen.add(name);
  if (typeof description !== "string" || description.trim() === "") {
    fail(`${at} ('${name}'): 'description' must be a non-empty string.`);
  }
  if (valueForm === undefined) return;

  if (typeof valueForm !== "object" || valueForm === null || Array.isArray(valueForm)) {
    fail(`${at} ('${name}'): 'valueForm' must be an object.`);
  }
  const unknownForm = Object.keys(valueForm).filter((key) => !VALUE_FORM_KEYS.has(key));
  if (unknownForm.length > 0) {
    fail(
      `${at} ('${name}'): unknown valueForm key(s) ${unknownForm.join(", ")}. ` +
        `Known: ${[...VALUE_FORM_KEYS].join(", ")}.`,
    );
  }
  const { pattern, form, examples } = valueForm;
  // Anchored, so a value matches whole in every regex dialect a kernel uses.
  if (typeof pattern !== "string" || !pattern.startsWith("^") || !pattern.endsWith("$")) {
    fail(`${at} ('${name}'): valueForm 'pattern' must be a string anchored with ^ and $.`);
  }
  let regex;
  try {
    regex = new RegExp(pattern);
  } catch (err) {
    fail(`${at} ('${name}'): valueForm 'pattern' does not compile: ${err.message}`);
  }
  if (typeof form !== "string" || form.trim() === "") {
    fail(`${at} ('${name}'): valueForm 'form' must be a non-empty string.`);
  }
  if (!Array.isArray(examples) || examples.length === 0) {
    fail(`${at} ('${name}'): valueForm 'examples' must be a non-empty array.`);
  }
  for (const example of examples) {
    if (typeof example !== "string" || !regex.test(example)) {
      fail(`${at} ('${name}'): example ${JSON.stringify(example)} does not match its own pattern.`);
    }
  }
  valueForms.push({ name, pattern, form, examples });
});

const names = axes.map((entry) => entry.name);
const literalList = (values) => `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;
const formLines = valueForms.map(
  ({ name, pattern, form, examples }) =>
    `  ${name}: {\n` +
    `    pattern: new RegExp(${JSON.stringify(pattern)}),\n` +
    `    form: ${JSON.stringify(form)},\n` +
    `    examples: ${literalList(examples)},\n` +
    `  },`,
);

const contents = `// GENERATED by scripts/generate-artifact-axes.mjs from analyzer/artifact-axes/axes.json — do not edit.

/** The selector platform axes, in canonical order. Closed as a set of axis
 *  names; the set of values stays open. */
export const PLATFORM_AXES = ${literalList(names)} as const;

export type PlatformAxis = (typeof PLATFORM_AXES)[number];

/** A form an axis value must take beyond the shared token grammar. */
export interface AxisValueForm {
  readonly pattern: RegExp;
  /** The form as a reader writes it, e.g. \`<family>-<version>\`. */
  readonly form: string;
  readonly examples: readonly string[];
}

/** The axes whose values carry a form of their own. */
export const AXIS_VALUE_FORMS: Readonly<Partial<Record<PlatformAxis, AxisValueForm>>> = {
${formLines.join("\n")}
};
`;

if (existsSync(DEST) && readFileSync(DEST, "utf8") === contents) {
  process.exit(0);
}

writeFileSync(DEST, contents);
console.log(`generate-artifact-axes: wrote ${names.length} selector axes (${names.join(", ")})`);
