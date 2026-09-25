/** Telo validating formats: `format:` values whose grammar Telo checks.
 *
 *  The vocabulary is DATA (`analyzer/formats/*.json`, copied in by
 *  `scripts/copy-format-entries.mjs`); the checker is this runtime's binding of a
 *  name. An entry names the grammar, a conforming stand-in and a conformance set,
 *  and carries no code, so every runtime reads the same vocabulary.
 *
 *  A format reaches AJV as an ordinary `addFormat`, registered by
 *  `registerTeloKeywords` beside the keywords. Standalone validators the kernel
 *  caches on disk name every format through ONE code expression, which
 *  `registerTeloKeywords` points at {@link TELO_AJV_FORMATS} — this package's
 *  own table, served to a cached validator by the kernel's realm — so a check
 *  survives the cache rather than being a closure lost on load. Browser-safe. */

import { fullFormats } from "ajv-formats/dist/formats.js";
import { cssSelectorChecker } from "./css-selector-format.js";
import { FORMAT_ENTRY_FILES } from "./formats/entries/index.js";

/** Why a value is not in a format's grammar. */
export interface TeloFormatFailure {
  /** What was expected, in the checker's words. */
  readonly reason: string;
  /** Zero-based offset into the value where the checker stopped. */
  readonly offset: number;
}

/** A runtime's binding of a format name. */
export interface TeloFormatChecker {
  check(value: string): TeloFormatFailure | undefined;
}

export interface TeloFormatEntry {
  readonly name: string;
  readonly grammar: string;
  readonly standIn: string;
  readonly description: string;
  readonly conformance: { readonly valid: readonly string[]; readonly invalid: readonly string[] };
}

const CHECKERS: Readonly<Record<string, TeloFormatChecker>> = {
  "css-selector": cssSelectorChecker,
};

const ENTRY_KEYS = new Set(["name", "grammar", "standIn", "description", "conformance"]);
const FORMAT_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export class TeloFormatEntryError extends Error {
  constructor(file: string, detail: string) {
    super(`analyzer/formats/${file}: ${detail}`);
    this.name = "TeloFormatEntryError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringList(file: string, value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TeloFormatEntryError(file, `'conformance.${field}' must be an array of strings`);
  }
  return value as string[];
}

function parseEntry(file: string, data: unknown): TeloFormatEntry {
  if (!isObject(data)) throw new TeloFormatEntryError(file, "an entry is a JSON object");
  const unknown = Object.keys(data).filter((key) => key !== "$comment" && !ENTRY_KEYS.has(key));
  if (unknown.length > 0) {
    throw new TeloFormatEntryError(
      file,
      `unknown key(s) ${unknown.join(", ")}; an entry declares ${[...ENTRY_KEYS].join(", ")}`,
    );
  }
  for (const field of ["name", "grammar", "standIn", "description"] as const) {
    if (typeof data[field] !== "string" || (field !== "standIn" && data[field] === "")) {
      throw new TeloFormatEntryError(file, `'${field}' must be a non-empty string`);
    }
  }
  const name = data.name as string;
  if (!FORMAT_NAME.test(name)) {
    throw new TeloFormatEntryError(file, `'name' must be lower-case and dash-separated, got '${name}'`);
  }
  if (!isObject(data.conformance)) {
    throw new TeloFormatEntryError(file, "'conformance' must be an object with 'valid' and 'invalid'");
  }
  return {
    name,
    grammar: data.grammar as string,
    standIn: data.standIn as string,
    description: data.description as string,
    conformance: {
      valid: stringList(file, data.conformance.valid, "valid"),
      invalid: stringList(file, data.conformance.invalid, "invalid"),
    },
  };
}

function buildRegistry(): ReadonlyMap<string, TeloFormatEntry> {
  const registry = new Map<string, TeloFormatEntry>();
  for (const [file, data] of FORMAT_ENTRY_FILES) {
    const entry = parseEntry(file, data);
    if (registry.has(entry.name)) {
      throw new TeloFormatEntryError(file, `'${entry.name}' is already declared by another entry`);
    }
    // A format nothing checks would accept every string at every slot declaring
    // it, so a name with no binding is a startup error, never a skipped check.
    const checker = CHECKERS[entry.name];
    if (!checker) {
      throw new TeloFormatEntryError(
        file,
        `'${entry.name}' has no checker in this runtime — a format nothing checks would ` +
          `silently accept every string at every slot declaring it`,
      );
    }
    if (checker.check(entry.standIn)) {
      throw new TeloFormatEntryError(file, `'standIn' is not a valid ${entry.name}`);
    }
    registry.set(entry.name, entry);
  }
  if (registry.size === 0) {
    throw new Error(
      "The Telo format vocabulary is empty. `analyzer/formats/*.json` did not reach this " +
        "build — check the file allowlist of whatever packaged it.",
    );
  }
  return registry;
}

/** Every Telo format, keyed by its `format:` value. */
export const TELO_FORMATS: ReadonlyMap<string, TeloFormatEntry> = buildRegistry();

/** The Telo format a schema node declares, or undefined for any other node —
 *  including one declaring a JSON Schema format such as `email`. */
export function teloFormatOf(schema: unknown): TeloFormatEntry | undefined {
  if (!isObject(schema) || typeof schema.format !== "string") return undefined;
  return TELO_FORMATS.get(schema.format);
}

/** Why `value` is not in the grammar of the Telo format `name`, or undefined
 *  when it is (or when `name` is not a Telo format). */
export function teloFormatFailure(name: string, value: string): TeloFormatFailure | undefined {
  return TELO_FORMATS.has(name) ? CHECKERS[name]!.check(value) : undefined;
}

/** The sentence a refusal prints, after the value's path. */
export function describeTeloFormatFailure(
  name: string,
  value: string,
  failure: TeloFormatFailure,
): string {
  return `must be a ${name}: ${failure.reason} at offset ${failure.offset} of ${JSON.stringify(value)}`;
}

/** Every format an AJV instance in the runtime may name — JSON Schema's own
 *  (`ajv-formats`' full set) plus the Telo formats — as one table, because a
 *  standalone validator reaches all of them through one code expression. */
export const TELO_AJV_FORMATS: Readonly<Record<string, unknown>> = {
  ...fullFormats,
  ...Object.fromEntries(
    [...TELO_FORMATS.keys()].map((name) => [
      name,
      { type: "string", validate: (value: string) => CHECKERS[name]!.check(value) === undefined },
    ]),
  ),
};
