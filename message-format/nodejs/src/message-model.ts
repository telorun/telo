/**
 * The message model: what a Message is once read. It is plain JSON — a host sends a
 * parsed Message across a wire and the other side formats it unchanged.
 *
 * - A pattern is a list of parts: literal text (a string, never empty, never two in a
 *   row) and placeholders (`{ placeholder: name }`).
 * - A plural selection is the YAML shape with its patterns parsed: `plural` names the
 *   number it selects on, `cases` maps a CLDR category or `=N` to a Message, and
 *   `other` is always present.
 */

export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;

export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

export type PatternPart = string | { readonly placeholder: string };

export type Pattern = readonly PatternPart[];

export interface PluralSelection {
  readonly plural: string;
  readonly cases: Readonly<Record<string, Message>>;
}

export type Message = Pattern | PluralSelection;

/** A Message with the context that tells it apart from the same words used elsewhere;
 *  `null` when it has none. */
export interface Text {
  readonly message: Message;
  readonly context: string | null;
}

export function isPluralCategory(key: string): key is PluralCategory {
  return (PLURAL_CATEGORIES as readonly string[]).includes(key);
}

export function isPattern(message: Message): message is Pattern {
  return Array.isArray(message);
}
