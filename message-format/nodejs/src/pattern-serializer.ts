import type { Pattern } from "./message-model.js";

/** A pattern in its one canonical spelling: `\`, `{` and `}` escaped, every
 *  placeholder written `{$name}`. Reading it back answers the same pattern. */
export function serializePattern(pattern: Pattern): string {
  let text = "";
  for (const part of pattern) {
    text += typeof part === "string" ? part.replace(/[\\{}]/g, (character) => `\\${character}`) : `{$${part.placeholder}}`;
  }
  return text;
}
