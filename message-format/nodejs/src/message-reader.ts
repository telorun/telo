/**
 * Reads a Message, or a Text, from the data a manifest or a wire holds. A value that
 * is not a well-formed Message or Text is refused as `MESSAGE_SYNTAX_INVALID`, every
 * fault reported where it sits: an unparsable pattern, a selection with no `other`, a
 * case key that is not a category or a canonical `=N` inside int64 ∪ uint64, a
 * selector that is not a name, an empty context.
 */

import { isPluralCategory, type Message, type Text } from "./message-model.js";
import { syntaxProblem, type MessageProblem } from "./message-problem.js";
import { parsePatternAt } from "./pattern-parser.js";
import { placeholderNameRefusal } from "./placeholder-name.js";

export type MessageResult =
  | { readonly ok: true; readonly message: Message }
  | { readonly ok: false; readonly problems: readonly MessageProblem[] };

export type TextResult =
  | { readonly ok: true; readonly text: Text }
  | { readonly ok: false; readonly problems: readonly MessageProblem[] };

const EXACT_KEY = /^=(-?(?:0|[1-9][0-9]*))$/;
const INT64_MIN = -(2n ** 63n);
const UINT64_MAX = 2n ** 64n - 1n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readMessage(data: unknown): MessageResult {
  const problems: MessageProblem[] = [];
  const message = readMessageAt(data, [], problems);
  return message === null || problems.length > 0 ? { ok: false, problems } : { ok: true, message };
}

export function readText(data: unknown): TextResult {
  const problems: MessageProblem[] = [];
  if (!isRecord(data) || (!Object.hasOwn(data, "text") && !Object.hasOwn(data, "context"))) {
    const message = readMessageAt(data, [], problems);
    return message === null || problems.length > 0 ? { ok: false, problems } : { ok: true, text: { message, context: null } };
  }
  for (const key of Object.keys(data)) {
    if (key !== "text" && key !== "context") {
      problems.push(syntaxProblem(`${key} is not a key of a text: it holds text and context`, [key]));
    }
  }
  const message = Object.hasOwn(data, "text")
    ? readMessageAt(data.text, ["text"], problems)
    : (problems.push(syntaxProblem("a text written as an object holds its message in text", [])), null);
  let context: string | null = null;
  if (!Object.hasOwn(data, "context")) {
    problems.push(
      syntaxProblem("a text written as an object names its context; write the message alone for no context", []),
    );
  } else if (typeof data.context !== "string") {
    problems.push(syntaxProblem("context is a string", ["context"]));
  } else if (data.context === "") {
    problems.push(syntaxProblem("context cannot be empty: write the message alone for no context", ["context"]));
  } else {
    context = data.context;
  }
  return message === null || context === null || problems.length > 0
    ? { ok: false, problems }
    : { ok: true, text: { message, context } };
}

/** Why `key` is not a case of a selection, or `null` when it is one. */
function caseKeyRefusal(key: string): string | null {
  if (isPluralCategory(key)) return null;
  if (!key.startsWith("=")) return `${key} is not a case: a case is zero, one, two, few, many, other or =N`;
  const exact = EXACT_KEY.exec(key);
  if (exact === null || exact[1] === "-0") {
    return `${key} is not a case: an exact case is = and an integer written with no leading zero, no + and no -0`;
  }
  const value = BigInt(exact[1]);
  if (value < INT64_MIN || value > UINT64_MAX) return `${key} is outside the 64-bit integer range of an exact case`;
  return null;
}

function readMessageAt(data: unknown, path: readonly string[], problems: MessageProblem[]): Message | null {
  if (typeof data === "string") {
    const result = parsePatternAt(data, path);
    if (result.ok) return result.pattern;
    problems.push(result.problem);
    return null;
  }
  if (!isRecord(data)) {
    problems.push(syntaxProblem("a message is text or a plural selection", path));
    return null;
  }
  const before = problems.length;
  for (const key of Object.keys(data)) {
    if (key !== "plural" && key !== "cases") {
      problems.push(syntaxProblem(`${key} is not a key of a plural selection: it holds plural and cases`, [...path, key]));
    }
  }
  let plural: string | null = null;
  if (!Object.hasOwn(data, "plural")) {
    problems.push(syntaxProblem("a plural selection names its selector in plural", path));
  } else if (typeof data.plural !== "string") {
    problems.push(syntaxProblem("plural holds the bare name of the number it selects on", [...path, "plural"]));
  } else {
    const refusal = placeholderNameRefusal(data.plural);
    if (refusal === null) plural = data.plural;
    else problems.push(syntaxProblem(refusal, [...path, "plural"]));
  }
  const cases: Record<string, Message> = {};
  if (!Object.hasOwn(data, "cases")) {
    problems.push(syntaxProblem("a plural selection lists its cases in cases", path));
  } else if (!isRecord(data.cases)) {
    problems.push(syntaxProblem("cases maps each plural category or =N to a message", [...path, "cases"]));
  } else {
    const written = data.cases;
    for (const key of Object.keys(written)) {
      const casePath = [...path, "cases", key];
      const refusal = caseKeyRefusal(key);
      if (refusal !== null) {
        problems.push(syntaxProblem(refusal, casePath));
        continue;
      }
      const message = readMessageAt(written[key], casePath, problems);
      if (message !== null) cases[key] = message;
    }
    if (!Object.hasOwn(written, "other")) {
      problems.push(syntaxProblem("a plural selection needs an other case", [...path, "cases"]));
    }
  }
  return plural === null || problems.length > before ? null : { plural, cases };
}
