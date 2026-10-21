/**
 * What is wrong with a text, a catalog or a message's values — one judgement both
 * halves read: `telo check` over literals, where each is written, and the kernel
 * over the values a resource is created with and a call is bound with
 * (`ERR_<code>`). Each problem carries its path below the site it was asked about
 * and a sentence naming no location, which the caller prefixes.
 *
 * The message core decides syntax, identity, placeholders and plural categories;
 * this file only relates them to a site. Browser-safe: no Node built-ins.
 */
import {
  invalidPluralCategories,
  isCelUint,
  isPattern,
  messageIdentity,
  messageVariables,
  readMessage,
  readText,
  unknownVariables,
  type Message,
  type MessageProblem,
  type Text,
} from "@telorun/sdk";
import type { ValuePath } from "./text-slot.js";

export type TextProblemCode =
  | "MESSAGE_SYNTAX_INVALID"
  | "MESSAGE_PLURAL_CATEGORY_INVALID"
  | "MESSAGE_SOURCE_LANGUAGE_MISSING"
  | "MESSAGE_PLACEHOLDER_UNKNOWN"
  | "MESSAGE_PLACEHOLDER_UNBOUND"
  | "MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED"
  | "MESSAGE_ENTRY_COMPUTED"
  | "MESSAGE_ENTRY_DUPLICATE";

export interface TextProblem {
  readonly code: TextProblemCode;
  readonly message: string;
  /** Below the site the judgement was asked about. */
  readonly path: ValuePath;
}

function coreProblem(problem: MessageProblem, prefix: ValuePath): TextProblem {
  const where =
    problem.range === null ? "" : ` (at offset ${problem.range.start} of the pattern)`;
  return { code: problem.code as TextProblemCode, message: `${problem.message}${where}`, path: [...prefix, ...problem.path] };
}

/** True when the message selects a plural case anywhere. */
export function selectsPlural(message: Message): boolean {
  return !isPattern(message);
}

/** The sentence `MESSAGE_SOURCE_LANGUAGE_MISSING` says. */
export const SOURCE_LANGUAGE_MISSING_MESSAGE =
  "this text selects a plural case, but the module that writes it declares no lang:, so " +
  "nothing says which language's plural rules select it — add lang: <language tag> to the " +
  "module document, naming the language its texts are written in";

/** The text a `Text` slot holds, read — or its problems. `lang` is the writing
 *  module's `lang:`, `null` when it declares none. */
export function judgeText(
  value: unknown,
  lang: string | null,
): { text?: Text; problems: TextProblem[] } {
  const read = readText(value);
  if (!read.ok) return { problems: read.problems.map((problem) => coreProblem(problem, [])) };
  return { text: read.text, problems: languageProblems(read.text.message, lang, isTextObject(value) ? ["text"] : []) };
}

function isTextObject(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "text");
}

/** A source message judged against its writer's language. */
export function languageProblems(message: Message, lang: string | null, prefix: ValuePath): TextProblem[] {
  if (!selectsPlural(message)) return [];
  if (lang === null) {
    return [{ code: "MESSAGE_SOURCE_LANGUAGE_MISSING", message: SOURCE_LANGUAGE_MISSING_MESSAGE, path: prefix }];
  }
  return invalidPluralCategories(message, lang).map((problem) => coreProblem(problem, prefix));
}

/** A Message written where no source language applies (inside another value). */
export function judgeMessage(value: unknown): { message?: Message; problems: TextProblem[] } {
  const read = readMessage(value);
  return read.ok
    ? { message: read.message, problems: [] }
    : { problems: read.problems.map((problem) => coreProblem(problem, [])) };
}

/** The key two source texts share exactly when they are one text. */
export function textKey(source: string, context: string | null): string {
  return JSON.stringify([source, context]);
}

/** The key of a read text. */
export function keyOfText(text: Text): string {
  return textKey(messageIdentity(text.message), text.context);
}

/** One entry of a catalog, read. */
export interface CatalogEntry {
  readonly index: number;
  readonly key: string;
  readonly source: Message;
  readonly translation: Message;
}

const ENTRY_COMPUTED_MESSAGE =
  "a text catalog holds literals only — this value is computed, so it cannot be checked " +
  "against its source or looked up; write the translation itself";

/** A catalog an expression produces, whole or in part: what refuses it. */
export function catalogComputedProblem(): TextProblem {
  return {
    code: "MESSAGE_ENTRY_COMPUTED",
    message:
      "a text catalog holds literals only — this value is computed, so the catalogs it produces cannot " +
      "be checked against their sources or looked up; write each catalog itself",
    path: [],
  };
}

/**
 * A `TextCatalog` value judged whole: every expression inside it
 * (`MESSAGE_ENTRY_COMPUTED`), each entry's text and translation, each translation
 * against its source's placeholders and against the catalog's `lang`, and one
 * (text, context) pair written twice. Returns the entries that read.
 */
export function judgeCatalog(
  catalog: unknown,
  isExpression: (value: unknown) => boolean,
): { entries: CatalogEntry[]; problems: TextProblem[] } {
  const problems: TextProblem[] = [];
  const entries: CatalogEntry[] = [];
  const computed = expressionPaths(catalog, isExpression, []);
  for (const path of computed) problems.push({ code: "MESSAGE_ENTRY_COMPUTED", message: ENTRY_COMPUTED_MESSAGE, path });
  if (computed.length > 0) return { entries, problems };
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return { entries, problems };
  const { lang, texts } = catalog as { lang?: unknown; texts?: unknown };
  if (!Array.isArray(texts)) return { entries, problems };
  const seen = new Map<string, number>();
  texts.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const { text, translation, context } = entry as Record<string, unknown>;
    const source = judgeMessage(text);
    const target = judgeMessage(translation);
    problems.push(
      ...source.problems.map((p) => ({ ...p, path: ["texts", index, "text", ...p.path] })),
      ...target.problems.map((p) => ({ ...p, path: ["texts", index, "translation", ...p.path] })),
    );
    if (!source.message || !target.message) return;
    const at: ValuePath = ["texts", index, "translation"];
    for (const problem of unknownVariables(target.message, source.message)) problems.push(coreProblem(problem, at));
    if (typeof lang === "string") {
      for (const problem of invalidPluralCategories(target.message, lang)) problems.push(coreProblem(problem, at));
    }
    const key = textKey(messageIdentity(source.message), typeof context === "string" ? context : null);
    const first = seen.get(key);
    if (first !== undefined) {
      problems.push({
        code: "MESSAGE_ENTRY_DUPLICATE",
        message: `this entry translates the same text and context as texts[${first}], so only one of them could ever be used`,
        path: ["texts", index],
      });
      return;
    }
    seen.set(key, index);
    entries.push({ index, key, source: source.message, translation: target.message });
  });
  return { entries, problems };
}

function expressionPaths(
  value: unknown,
  isExpression: (value: unknown) => boolean,
  path: ValuePath,
): ValuePath[] {
  if (isExpression(value)) return [path];
  if (Array.isArray(value)) return value.flatMap((item, index) => expressionPaths(item, isExpression, [...path, index]));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.entries(value).flatMap(([key, child]) => expressionPaths(child, isExpression, [...path, key]));
  }
  return [];
}

/** What a message's value is known to be: a string, a number, something a message
 *  refuses, or not known until evaluated. */
export type MessageValueKind = "string" | "number" | "refused" | "unknown";

/** The values bound to a message, as far as they are known: absent when the
 *  values themselves are not known (a computed map). */
export type KnownValues = ReadonlyMap<string, { kind: MessageValueKind; describe: string }>;

/**
 * A message's values judged: every name the message reads — placeholders and
 * selectors — must be a key (`MESSAGE_PLACEHOLDER_UNBOUND`), and a known value
 * must be a string or a number, and a number where it selects
 * (`MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED`). Extra keys are legal.
 */
export function judgeValues(message: Message, values: KnownValues): TextProblem[] {
  const problems: TextProblem[] = [];
  const selectors = selectorNames(message);
  for (const name of messageVariables(message)) {
    const value = values.get(name);
    if (!value) {
      problems.push({
        code: "MESSAGE_PLACEHOLDER_UNBOUND",
        message: `no value is given for ${name}, which the message reads${selectors.has(name) ? " to select a plural case" : ""}`,
        path: [],
      });
      continue;
    }
    if (value.kind === "refused" || (value.kind === "string" && selectors.has(name))) {
      problems.push({
        code: "MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED",
        message: selectors.has(name)
          ? `the value given for ${name} is ${value.describe}, and ${name} selects a plural case, which needs a number`
          : `the value given for ${name} is ${value.describe}, and a placeholder takes a string or a number`,
        path: [name],
      });
    }
  }
  return problems;
}

function selectorNames(message: Message): Set<string> {
  const out = new Set<string>();
  const pending: Message[] = [message];
  while (pending.length > 0) {
    const at = pending.pop()!;
    if (isPattern(at)) continue;
    out.add(at.plural);
    pending.push(...Object.values(at.cases));
  }
  return out;
}

/** What a value handed to a message at runtime is. */
export function runtimeValueKind(value: unknown): { kind: MessageValueKind; describe: string } {
  if (typeof value === "string") return { kind: "string", describe: "a string" };
  if (typeof value === "number" || typeof value === "bigint" || isCelUint(value)) {
    return { kind: "number", describe: "a number" };
  }
  if (value === null) return { kind: "refused", describe: "null" };
  if (typeof value === "boolean") return { kind: "refused", describe: "a boolean" };
  if (Array.isArray(value)) return { kind: "refused", describe: "a list" };
  return { kind: "refused", describe: "neither a string nor a number" };
}

/** What a CEL type admits as a message value; `unknown` for `dyn` or no type. */
export function celTypeValueKind(type: string | undefined): { kind: MessageValueKind; describe: string } {
  if (type === undefined || type === "dyn") return { kind: "unknown", describe: "a value of unknown type" };
  if (type === "string") return { kind: "string", describe: "a string" };
  if (type === "int" || type === "uint" || type === "double") return { kind: "number", describe: `a ${type}` };
  return { kind: "refused", describe: `a ${type}` };
}

/** What a declared schema admits as a message value, by its `type`; `unknown`
 *  where it states none. */
export function schemaValueKind(schema: unknown): { kind: MessageValueKind; describe: string } {
  const type = schema && typeof schema === "object" ? (schema as { type?: unknown }).type : undefined;
  if (type === "string") return { kind: "string", describe: "a string" };
  if (type === "integer" || type === "number") return { kind: "number", describe: `a value declared ${type}` };
  if (type === "boolean" || type === "null" || type === "array" || type === "object") {
    return { kind: "refused", describe: `a value declared ${type}` };
  }
  return { kind: "unknown", describe: "a value of unknown type" };
}
