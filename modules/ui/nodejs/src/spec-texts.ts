import { serializePattern, type TextRecord } from "@telorun/sdk";
import type { JsonSchema } from "./model-schema.js";

/**
 * The texts `ui` puts in what a renderer receives. A text an author wrote
 * arrives as the record the kernel built; a text read off a data schema — a
 * property's `title` or `description`, an enum value's label — is built here
 * in the same shape, so a renderer translates both the same way; a default
 * `ui` fills is one of the renderer's own words, by id.
 */

/** One of `Ui.Words`. */
export interface WordRef {
  word: string;
}

export type SpecText = TextRecord | WordRef;

const TEXT_CONTEXT = "x-telo-text-context";

/** The context a data schema node gives its title, description and enum labels. */
export function textContextOf(node: unknown): string | null {
  const context = node && typeof node === "object" ? (node as JsonSchema)[TEXT_CONTEXT] : undefined;
  return typeof context === "string" && context !== "" ? context : null;
}

/**
 * A text a data schema shows, as the record it is looked up by: its words as a
 * literal pattern — the key a catalog entry translating it is checked against —
 * and the context of the node writing it. No API says which module wrote a
 * schema, so its language is undetermined; a literal reads the same in any.
 */
export function schemaText(text: string, context: string | null): TextRecord {
  return { text: serializePattern(text === "" ? [] : [text]), context, lang: "und", computed: false };
}

/** A renderer's own word. */
export const word = (id: string): WordRef => ({ word: id });

/** A property's description, or none. */
export function descriptionOf(property: JsonSchema | undefined): TextRecord | null {
  return typeof property?.description === "string" ? schemaText(property.description, textContextOf(property)) : null;
}

/** What each value of an enumeration is shown as. */
export interface ValueLabel {
  value: unknown;
  label: SpecText;
}

/**
 * The labels of a scalar's values — of a list's items for a list: one per
 * titled `const` branch of its `oneOf` / `anyOf`, then one per string `enum`
 * value no branch titles, its label the value itself. The value sent back is
 * the value; only what it is shown as is translated.
 */
export function labelsOf(property: JsonSchema | undefined): ValueLabel[] {
  if (!property || typeof property !== "object") return [];
  const types = property.type === undefined ? [] : [property.type].flat();
  const element: JsonSchema =
    types.includes("array") && property.items && typeof property.items === "object" && !Array.isArray(property.items)
      ? property.items
      : property;
  const labels: ValueLabel[] = [];
  const labelled = (value: unknown) => labels.some((entry) => JSON.stringify(entry.value) === JSON.stringify(value));
  for (const key of ["oneOf", "anyOf"]) {
    const branches = element[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (!branch || typeof branch !== "object" || !("const" in branch) || typeof branch.title !== "string") continue;
      if (labelled(branch.const)) continue;
      labels.push({ value: branch.const, label: schemaText(branch.title, textContextOf(branch)) });
    }
  }
  if (Array.isArray(element.enum)) {
    for (const value of element.enum) {
      if (typeof value !== "string" || labelled(value)) continue;
      labels.push({ value, label: schemaText(value, textContextOf(element)) });
    }
  }
  return labels;
}

/** The text a record holds as written, when it is a plain pattern. */
export function writtenPattern(text: SpecText): string | undefined {
  return "text" in text && typeof text.text === "string" ? text.text : undefined;
}

/** Whether two records hold the same text as written, with the same context —
 *  how a label naming a choice is told apart, as the static rules compare it. */
export function sameWritten(a: TextRecord, b: TextRecord): boolean {
  return a.context === b.context && JSON.stringify(a.text) === JSON.stringify(b.text);
}

/** A label as a message quotes it: its words as written. */
export function quotedText(text: TextRecord): string {
  return typeof text.text === "string" ? `'${text.text}'` : JSON.stringify(text.text);
}
