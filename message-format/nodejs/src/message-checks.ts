/**
 * The two checks that relate a read Message to something outside it: its source text
 * (a translation may read only the names its source reads) and its language (a
 * selection may name only the plural categories that language has).
 */

import { pluralCategories } from "./cldr-locale.js";
import { isPattern, isPluralCategory, type Message } from "./message-model.js";
import type { MessageProblem } from "./message-problem.js";
import { messageVariables } from "./message-identity.js";

/** Walks a message depth-first in written order: each selection before its cases. */
function walk(message: Message, visit: (at: Message, path: readonly string[]) => void): void {
  const pending: { at: Message; path: readonly string[] }[] = [{ at: message, path: [] }];
  while (pending.length > 0) {
    const { at, path } = pending.pop()!;
    visit(at, path);
    if (!isPattern(at)) {
      const entries = Object.entries(at.cases);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, child] = entries[index];
        pending.push({ at: child, path: [...path, "cases", key] });
      }
    }
  }
}

/** `MESSAGE_PLACEHOLDER_UNKNOWN` for each name the translation reads and its source does not. */
export function unknownVariables(translation: Message, source: Message): readonly MessageProblem[] {
  const known = new Set(messageVariables(source));
  const problems: MessageProblem[] = [];
  const unknown = (name: string, path: readonly string[]): void => {
    problems.push({
      code: "MESSAGE_PLACEHOLDER_UNKNOWN",
      message: `${name} is not a placeholder of the source text`,
      path,
      range: null,
    });
  };
  walk(translation, (at, path) => {
    if (isPattern(at)) {
      const reported = new Set<string>();
      for (const part of at) {
        if (typeof part === "string" || known.has(part.placeholder) || reported.has(part.placeholder)) continue;
        reported.add(part.placeholder);
        unknown(part.placeholder, path);
      }
    } else if (!known.has(at.plural)) {
      unknown(at.plural, [...path, "plural"]);
    }
  });
  return problems;
}

/** `MESSAGE_PLURAL_CATEGORY_INVALID` for each case naming a category `lang` lacks. */
export function invalidPluralCategories(message: Message, lang: string): readonly MessageProblem[] {
  const categories = pluralCategories(lang);
  const problems: MessageProblem[] = [];
  walk(message, (at, path) => {
    if (isPattern(at)) return;
    for (const key of Object.keys(at.cases)) {
      if (!isPluralCategory(key) || categories.includes(key)) continue;
      problems.push({
        code: "MESSAGE_PLURAL_CATEGORY_INVALID",
        message: `${key} is not a plural category of ${lang}: its categories are ${categories.join(", ")}`,
        path: [...path, "cases", key],
        range: null,
      });
    }
  });
  return problems;
}
