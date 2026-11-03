import { readMessage } from "@telorun/message-format";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import type { Texts, TranslatedText } from "../src/browser/texts.js";

/** A text as the server sends it: the Message parsed, in English. */
export function wireText(text: unknown, lang = "en") {
  const read = readMessage(text);
  if (!read.ok) throw new Error(`not a message: ${JSON.stringify(text)}`);
  return { message: read.message, lang };
}

const uiDocuments: Record<string, any>[] = parseAllDocuments(readFileSync(join(process.cwd(), "../../ui/telo.yaml"), "utf8"), { logLevel: "silent" }).map((doc) => doc.toJS());
const declaration = uiDocuments.find((doc) => doc.kind === "Telo.KeyedTranslations") ?? (() => {
  throw new Error("ui declares no keyed texts");
})();

/** The canonical kind of `ui`'s own keyed set, read from its declaration. */
export const UI_SET = `${uiDocuments[0].metadata.name}.${declaration.metadata.name}`;

/** Every key `ui` declares. */
export const uiKeys: string[] = Object.keys(declaration.keys);

/** A key's English source: its entry, or the entry's `message`. */
const sourceOf = (entry: unknown): unknown =>
  entry !== null && typeof entry === "object" && "message" in entry ? (entry as { message: unknown }).message : entry;

/** `ui`'s own texts in English, as a server sends them. */
export const englishMessages: Record<string, TranslatedText> = Object.fromEntries(
  Object.entries(declaration.keys).map(([key, entry]) => [key, wireText(sourceOf(entry))]),
);

/** The application document's `texts` holding `ui`'s set alone, as the renderer's own. */
export function uiTexts(messages: Record<string, TranslatedText> = {}): Texts {
  return { own: UI_SET, sets: { [UI_SET]: { ...englishMessages, ...messages } } };
}

/** A key of `ui`'s own set as a node carries it. */
export const uiText = (key: string) => ({ set: UI_SET, key });
