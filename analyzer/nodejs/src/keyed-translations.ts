import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { readMessage } from "@telorun/sdk";
import { expandManifestFragments, liftFragmentDefs, manifestFragmentRef } from "./manifest-schemas.js";
import {
  catalogComputedProblem,
  languageProblems,
  type TextProblem,
  type TextProblemCode,
} from "./text-judgement.js";
import { expressionsWithin, TEXT_VALUES_ANNOTATION, type ValuePath } from "./text-slot.js";
import { declaredValueRefusal, judgeDeclaredValues } from "./text-values.js";

/**
 * Keyed translations — THE single reader of `kind: Telo.KeyedTranslations`
 * documents, for `telo check` and the kernel alike, on the `need-type.ts`
 * precedent.
 *
 * The document declares a library's own texts by key, each with its source
 * wording in the module's `lang:` and the values it is formatted with. It
 * registers a kind `<Module>.<Name>` (by convention `Translations`) extending
 * `Telo.Translations`: a resource of it translates those keys into its own
 * `lang`, under `messages:` — a closed map in which every key is optional and
 * holds a `Message` carrying its key's values as `x-telo-text-values`. The kind
 * is synthesized here ({@link keyedTranslationsDefinition}) and read through
 * `kindDeclarationOf`, so both halves register one definition from one document.
 *
 * The text walk judges every message's syntax and its placeholders against the
 * values its slot declares, the source wording's included; this file adds what
 * only a keyed set knows — the source language, each key's declared values, a
 * catalog's plural categories against its own `lang`, and computed entries.
 *
 * Browser-safe — no I/O, no Node built-ins.
 */

export const KEYED_TRANSLATIONS_KIND = "Telo.KeyedTranslations";

/** The kernel controller entry every keyed kind names. */
export const KEYED_TRANSLATIONS_CONTROLLER_ENTRY = "Telo.KeyedTranslations";

/** The abstract every keyed kind extends. */
const TRANSLATIONS_ABSTRACT = "Telo.Translations";

/** One declared key: its source wording as written, the values it is formatted
 *  with (`{}` for none), and the translator's hint. */
export interface KeyedTextEntry {
  readonly message: unknown;
  readonly values: Readonly<Record<string, unknown>>;
  readonly description?: string;
}

/** What a keyed declaration declares, by key in written order. */
export interface KeyedTranslationsShape {
  readonly keys: Readonly<Record<string, KeyedTextEntry>>;
}

/** The marker the synthesized definition carries — read through
 *  {@link keyedTranslationsOf}, never by testing the field. */
const KEYED_TRANSLATIONS_MARKER = "keyedTranslations";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function isKeyedTranslationsDoc(manifest: { kind?: unknown } | undefined): boolean {
  return manifest?.kind === KEYED_TRANSLATIONS_KIND;
}

/** One `keys:` entry, read: the message and where it is written, and the values
 *  map when one is written. A bare message or a plural selection is the short
 *  form; an object naming `message` the long one. */
function readKeyEntry(entry: unknown): { message: unknown; at: ValuePath; values?: unknown; description?: unknown } {
  if (isPlainObject(entry) && Object.hasOwn(entry, "message") && !Object.hasOwn(entry, "plural")) {
    return { message: entry.message, at: ["message"], values: entry.values, description: entry.description };
  }
  return { message: entry, at: [] };
}

/** Read a `Telo.KeyedTranslations` document's keys. Malformed parts read as
 *  absent; the built-in schema reports them against the precise path. */
export function readKeyedTranslations(doc: unknown): KeyedTranslationsShape {
  const raw = isPlainObject(doc) ? doc.keys : undefined;
  const keys: Record<string, KeyedTextEntry> = {};
  if (isPlainObject(raw)) {
    for (const [key, entry] of Object.entries(raw)) {
      const read = readKeyEntry(entry);
      const values = isPlainObject(read.values) ? read.values : {};
      keys[key] = {
        message: read.message,
        values,
        ...(typeof read.description === "string" ? { description: read.description } : {}),
      };
    }
  }
  return { keys };
}

/**
 * The kind a `Telo.KeyedTranslations` document registers — reached through
 * `kindDeclarationOf`, which memoizes it per document.
 *
 * A `Telo.Provider` extending `Telo.Translations`, so its author schema is the
 * abstract's `lang` merged with its own closed `messages:` map: every declared key
 * optional, each a `Message` whose `x-telo-text-values` is the key's values
 * copied verbatim. An unknown key is refused by that schema, and a form or
 * completion reads the keys off it. Carries the document's authored `metadata`.
 */
export function keyedTranslationsDefinition(doc: ResourceManifest): ResourceDefinition {
  const shape = readKeyedTranslations(doc);
  const properties: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(shape.keys)) {
    properties[key] = {
      $ref: manifestFragmentRef("Message"),
      ...(entry.description ? { description: entry.description } : {}),
      [TEXT_VALUES_ANNOTATION]: structuredClone(entry.values),
    };
  }
  const definition = {
    kind: "Telo.Definition",
    metadata: { ...(doc.metadata ?? {}) },
    capability: "Telo.Provider",
    extends: TRANSLATIONS_ABSTRACT,
    controllers: [{ runtime: "kernel", entry: KEYED_TRANSLATIONS_CONTROLLER_ENTRY }],
    schema: {
      type: "object",
      properties: {
        messages: {
          title: "Messages",
          description: "The translation of each key into this resource's language. A key left out shows its source wording.",
          type: "object",
          properties,
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    [KEYED_TRANSLATIONS_MARKER]: shape,
  } as Record<string, unknown>;
  expandManifestFragments(definition);
  definition.schema = liftFragmentDefs(definition.schema as Record<string, unknown>);
  return definition as unknown as ResourceDefinition;
}

/** The keyed set a definition is synthesized from, or undefined for any other. */
export function keyedTranslationsOf(
  definition: ResourceDefinition | undefined,
): KeyedTranslationsShape | undefined {
  const marked = (definition as Record<string, unknown> | undefined)?.[KEYED_TRANSLATIONS_MARKER];
  return isPlainObject(marked) ? (marked as unknown as KeyedTranslationsShape) : undefined;
}

/** A problem with a keyed declaration or catalog, below the document or the
 *  catalog's value. */
export interface KeyedTranslationsProblem {
  readonly code: TextProblemCode | "TEXT_VALUES_INVALID";
  readonly message: string;
  readonly path: ValuePath;
}

/** The sentence `MESSAGE_SOURCE_LANGUAGE_MISSING` says at a keyed declaration. */
export const KEYED_SOURCE_LANGUAGE_MISSING_MESSAGE =
  "this module declares texts by key, but declares no lang:, so nothing says which language " +
  "their source wording is written in — add lang: <language tag> to the module document, naming " +
  "the language its texts are written in";

const entryComputed = (path: ValuePath): KeyedTranslationsProblem => ({
  ...catalogComputedProblem(),
  message:
    "a keyed text holds literals only — this value is computed, so it cannot be checked against " +
    "the values its key is formatted with; write the message itself",
  path,
});

const below = (base: ValuePath) => (problem: TextProblem): KeyedTranslationsProblem => ({
  ...problem,
  path: [...base, ...problem.path],
});

/**
 * A `Telo.KeyedTranslations` document judged, `lang` being its module's `lang:`
 * (`null` for none): the missing source language once (`MESSAGE_SOURCE_LANGUAGE_MISSING`),
 * an expression in a key (`MESSAGE_ENTRY_COMPUTED`), a declared value no message
 * can format (`TEXT_VALUES_INVALID`), and each source message's plural categories
 * against `lang` and its placeholders against its key's values. A message's
 * syntax is the text walk's; a malformed values map the schema's.
 */
export function judgeKeyedDeclaration(
  doc: unknown,
  lang: string | null,
  isExpression: (value: unknown) => boolean,
): KeyedTranslationsProblem[] {
  const keys = isPlainObject(doc) ? doc.keys : undefined;
  if (!isPlainObject(keys)) return [];
  const problems: KeyedTranslationsProblem[] = [];
  if (lang === null) {
    problems.push({ code: "MESSAGE_SOURCE_LANGUAGE_MISSING", message: KEYED_SOURCE_LANGUAGE_MISSING_MESSAGE, path: ["keys"] });
  }
  for (const [key, entry] of Object.entries(keys)) {
    const at: ValuePath = ["keys", key];
    const computed = expressionsWithin(entry, isExpression);
    if (computed.length > 0) {
      problems.push(...computed.map(({ path }) => entryComputed([...at, ...path])));
      continue;
    }
    const read = readKeyEntry(entry);
    let valuesReadable = read.values === undefined || isPlainObject(read.values);
    if (isPlainObject(read.values)) {
      for (const [name, schema] of Object.entries(read.values)) {
        if (!isPlainObject(schema) && typeof schema !== "boolean") {
          valuesReadable = false;
          continue;
        }
        const refusal = declaredValueRefusal(name, schema);
        if (!refusal) continue;
        valuesReadable = false;
        problems.push({
          code: "TEXT_VALUES_INVALID",
          message: `the key '${key}' declares ${refusal}`,
          path: [...at, "values", name],
        });
      }
    }
    const message = readMessage(read.message);
    if (!message.ok) continue;
    const messageAt = [...at, ...read.at];
    if (lang !== null) problems.push(...languageProblems(message.message, lang, []).map(below(messageAt)));
    if (valuesReadable) {
      const values = isPlainObject(read.values) ? read.values : {};
      problems.push(...judgeDeclaredValues(message.message, values).map(below(messageAt)));
    }
  }
  return problems;
}

/**
 * A resource of a keyed kind judged, `catalog` being what it writes beside
 * `kind` and `metadata`: an expression anywhere in it (`MESSAGE_ENTRY_COMPUTED`)
 * and each message's plural categories against the resource's own `lang`. A
 * message's syntax and its placeholders against its key's values are the text
 * walk's, through the kind's schema; an undeclared key the schema's.
 */
export function judgeKeyedCatalog(
  catalog: unknown,
  isExpression: (value: unknown) => boolean,
): KeyedTranslationsProblem[] {
  const computed = expressionsWithin(catalog, isExpression);
  if (computed.length > 0) return computed.map(({ path }) => entryComputed(path));
  if (!isPlainObject(catalog) || typeof catalog.lang !== "string" || !isPlainObject(catalog.messages)) return [];
  const problems: KeyedTranslationsProblem[] = [];
  for (const [key, value] of Object.entries(catalog.messages)) {
    const message = readMessage(value);
    if (message.ok) problems.push(...languageProblems(message.message, catalog.lang, ["messages", key]));
  }
  return problems;
}
