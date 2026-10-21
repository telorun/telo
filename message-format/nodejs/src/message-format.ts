/**
 * Formats a Message in a language with values for the names it reads.
 *
 * Every name the message reads must be bound — on every branch, not only the one a
 * count selects — so a missing value fails whatever the count is. A placeholder takes
 * a string, inserted as written, or a number, formatted by the language's CLDR rules;
 * a selector takes a number. Any other value is refused, a timestamp included: its
 * text depends on a time zone the message does not know.
 *
 * A selection matches its `=N` cases first, numerically against the number as
 * rounded for display, then the language's plural category of that number, then
 * `other`.
 */

import { numberEntryFor } from "./cldr-locale.js";
import { isPattern, type Message, type Pattern } from "./message-model.js";
import { MessageFormatError } from "./message-problem.js";
import {
  categoryOfOperands,
  decimalEquals,
  decimalOperands,
  localizedDecimal,
  numberRefusal,
  roundedDecimal,
  type NumberValue,
} from "./number-format.js";

export type MessageValue = string | NumberValue;

/** Refuses the first name, in written order, that is unbound or bound to a value it cannot take. */
function checkValues(message: Message, values: Readonly<Record<string, unknown>>): void {
  const pending: Message[] = [message];
  const check = (name: string, selector: boolean): void => {
    if (!Object.hasOwn(values, name)) {
      throw new MessageFormatError(
        "MESSAGE_PLACEHOLDER_UNBOUND",
        `no value is given for ${name}, which the message reads`,
      );
    }
    const value = values[name];
    const subject = `the value given for ${name}`;
    const refusal =
      typeof value === "string"
        ? selector
          ? `${subject} is not a number, and ${name} selects a plural case`
          : null
        : numberRefusal(value, subject);
    if (refusal !== null) {
      throw new MessageFormatError(
        "MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED",
        typeof value === "string" || typeof value === "number" || typeof value === "bigint"
          ? refusal
          : `${subject} is neither a string nor a number`,
      );
    }
  };
  while (pending.length > 0) {
    const at = pending.pop()!;
    if (isPattern(at)) {
      for (const part of at) if (typeof part !== "string") check(part.placeholder, false);
    } else {
      check(at.plural, true);
      pending.push(...Object.values(at.cases).reverse());
    }
  }
}

export function formatMessage(message: Message, lang: string, values: Readonly<Record<string, MessageValue>>): string {
  checkValues(message, values);
  const entry = numberEntryFor(lang);
  let at = message;
  while (!isPattern(at)) {
    const decimal = roundedDecimal(values[at.plural] as NumberValue, entry.pattern);
    let chosen: Message | undefined;
    for (const [key, branch] of Object.entries(at.cases)) {
      if (key.startsWith("=") && decimalEquals(decimal, key.slice(1))) {
        chosen = branch;
        break;
      }
    }
    at = chosen ?? at.cases[categoryOfOperands(decimalOperands(decimal), lang)] ?? at.cases.other;
  }
  let text = "";
  for (const part of at as Pattern) {
    if (typeof part === "string") {
      text += part;
    } else {
      const value = values[part.placeholder];
      text += typeof value === "string" ? value : localizedDecimal(roundedDecimal(value, entry.pattern), entry);
    }
  }
  return text;
}
