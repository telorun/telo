import { formatMessage, type Message, type MessageValue } from "@telorun/message-format";
import { createContext, useContext } from "react";
import { readBinding, type Binding } from "./bindings.js";
import { RootsContext } from "./renderer-context.js";

/**
 * A text as the browser receives it: the Message the server chose — translated,
 * or the source — already parsed, and the language it is written in; with the
 * values it is formatted with when the page names them; or a key of a keyed
 * set, by the set's canonical kind, drawn from the messages the application
 * document carries. The browser formats it with the message core — plural
 * choice, placeholders, numbers — and holds no catalog.
 */
export type WireText =
  | { message: Message; lang: string; values?: Readonly<Record<string, Binding>> }
  | { set: string; key: string };

/** A translated text with no values of its own. */
export type TranslatedText = { message: Message; lang: string };

/**
 * The keyed texts the application document carries: per set, each key's
 * message in the request's language, and which set the renderer's own texts —
 * its buttons, pager, validation messages — are drawn from.
 */
export interface Texts {
  own: string;
  sets: Readonly<Record<string, Readonly<Record<string, TranslatedText>>>>;
}

/** Before the application document arrives. */
export const NO_TEXTS: Texts = { own: "", sets: {} };

export const TextsContext = createContext<Texts>(NO_TEXTS);

/** What formats one of the renderer's own texts, for code that runs outside a component. */
export type Say = (key: string, values?: Readonly<Record<string, MessageValue>>) => string;

/** A value a page names, as a message reads it. */
function messageValue(value: unknown): MessageValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "bigint"
    ? value
    : (value as MessageValue);
}

/** `text` formatted: a key looked up in its set, a page's values read from the roots in scope. */
export function formatText(
  texts: Texts,
  text: WireText,
  roots: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, MessageValue>> = {},
): string {
  if ("set" in text) return formatKeyed(texts, text.set, text.key, values);
  const bound: Record<string, MessageValue> = { ...values };
  for (const [name, binding] of Object.entries(text.values ?? {})) {
    const read = readBinding(binding, roots);
    if (read.present) bound[name] = messageValue(read.value);
  }
  return formatMessage(text.message, text.lang, bound);
}

/** The message of `key` in `set`, formatted. */
export function formatKeyed(texts: Texts, set: string, key: string, values: Readonly<Record<string, MessageValue>> = {}): string {
  const message = texts.sets[set]?.[key];
  if (!message) throw new Error(`This renderer was sent no text '${key}' of the set '${set}'.`);
  return formatMessage(message.message, message.lang, values);
}

/** One of the renderer's own texts, formatted. */
export function formatOwn(texts: Texts, key: string, values: Readonly<Record<string, MessageValue>> = {}): string {
  return formatKeyed(texts, texts.own, key, values);
}

/** Whether the renderer was sent its own text `key`. */
export const holdsOwn = (texts: Texts, key: string): boolean => texts.sets[texts.own]?.[key] !== undefined;

/** What formats a wire text where it is drawn, over the roots in scope. */
export function useText(): (
  text: WireText,
  values?: Readonly<Record<string, MessageValue>>,
  roots?: Readonly<Record<string, unknown>>,
) => string {
  const texts = useContext(TextsContext);
  const scope = useContext(RootsContext);
  return (text, values, roots) => formatText(texts, text, roots ?? scope, values);
}

/** What formats one of the renderer's own texts. */
export function useSay(): Say {
  const texts = useContext(TextsContext);
  return (key, values) => formatOwn(texts, key, values);
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
export function findingText(finding: { path: string[]; text: { key: string; values?: Readonly<Record<string, MessageValue>> } }, say: Say): string {
  const why = say(finding.text.key, finding.text.values);
  return finding.path.length > 0 ? `${finding.path.join(".")}: ${why}` : why;
}
