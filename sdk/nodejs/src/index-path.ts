/**
 * The identity of an item a template repeat emits: a head and an index path —
 * one key per enclosing loop, outermost first, a map element's `string` key or
 * a list element's `int` index.
 *
 * ONE renderer writes it as CEL index literals (`['nightlyReport']`, `[0]`), the
 * text a family member is registered under (`crons['nightlyReport']`), an
 * emitted step is journaled under (`steps/runs['nightlyReport']`) and an emitted
 * inline declaration is named by. The text is output only: no reader parses it
 * back, every one reads the head and keys themselves.
 */

/** One key of an index path: a map element's key, or a list element's index. */
export type IndexKey = string | number;

/** `key` as a CEL index literal: an int bare, a string single-quoted with CEL's
 *  escapes. */
export function indexLiteral(key: IndexKey): string {
  if (typeof key === "number") return `[${key}]`;
  return `['${key.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r")}']`;
}

/** `keys` as CEL index literals, outermost first. */
export function renderIndexPath(keys: readonly IndexKey[]): string {
  return keys.map(indexLiteral).join("");
}

/** `head` followed by the index path of `keys`: `crons['nightlyReport']`. */
export function memberIdentity(head: string, keys: readonly IndexKey[]): string {
  return `${head}${renderIndexPath(keys)}`;
}
