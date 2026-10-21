import { formatMessage, type Message, type MessageValue } from "@telorun/message-format";
import { createContext, useContext } from "react";
import { readBinding, type Binding } from "./bindings.js";
import { RootsContext } from "./renderer-context.js";

/**
 * A text as the browser receives it: the Message the server chose — translated,
 * or the source — already parsed, and the language it is written in; with the
 * values it is formatted with when the page names them; or one of the
 * renderer's own words, by id. The browser formats it with the message core —
 * plural choice, placeholders, numbers — and holds no catalog.
 */
export type WireText =
  | { message: Message; lang: string; values?: Readonly<Record<string, Binding>> }
  | { word: string };

/** A translated text with no values of its own. */
export type TranslatedText = { message: Message; lang: string };

/** The renderer's own words, translated, by id. */
export type Words = Readonly<Record<string, TranslatedText>>;

export const WordsContext = createContext<Words>({});

/** What formats a renderer word, for code that runs outside a component. */
export type Say = (id: string, values?: Readonly<Record<string, MessageValue>>) => string;

/** A value a page names, as a message reads it. */
function messageValue(value: unknown): MessageValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "bigint"
    ? value
    : (value as MessageValue);
}

/** `text` formatted: a word looked up, a page's values read from the roots in scope. */
export function formatText(
  words: Words,
  text: WireText,
  roots: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, MessageValue>> = {},
): string {
  if ("word" in text) return formatWord(words, text.word, values);
  const bound: Record<string, MessageValue> = { ...values };
  for (const [name, binding] of Object.entries(text.values ?? {})) {
    const read = readBinding(binding, roots);
    if (read.present) bound[name] = messageValue(read.value);
  }
  return formatMessage(text.message, text.lang, bound);
}

export function formatWord(words: Words, id: string, values: Readonly<Record<string, MessageValue>> = {}): string {
  const word = words[id];
  if (!word) throw new Error(`This renderer was sent no word '${id}'.`);
  return formatMessage(word.message, word.lang, values);
}

/** What formats a wire text where it is drawn, over the roots in scope. */
export function useText(): (
  text: WireText,
  values?: Readonly<Record<string, MessageValue>>,
  roots?: Readonly<Record<string, unknown>>,
) => string {
  const words = useContext(WordsContext);
  const scope = useContext(RootsContext);
  return (text, values, roots) => formatText(words, text, roots ?? scope, values);
}

/** What formats one of the renderer's own words. */
export function useSay(): Say {
  const words = useContext(WordsContext);
  return (id, values) => formatWord(words, id, values);
}

/** What a value of an enumeration is shown as: its label, else its text. */
export interface ValueLabel {
  value: unknown;
  label: WireText;
}

export function labelFor(labels: readonly ValueLabel[] | undefined, value: unknown): WireText | undefined {
  return labels?.find((entry) => JSON.stringify(entry.value) === JSON.stringify(value))?.label;
}

/** A validation finding as it reads: the path to what failed, then why. */
export function findingText(finding: { path: string[]; word: { id: string; values?: Readonly<Record<string, MessageValue>> } }, say: Say): string {
  const why = say(finding.word.id, finding.word.values);
  return finding.path.length > 0 ? `${finding.path.join(".")}: ${why}` : why;
}
