import type { TemplatingEngine } from "../engine.js";

/** One `[<binding>.key]` / `[<binding>.index]` of an indexed `!ref`. */
export interface RefIndex {
  readonly binding: string;
  readonly member: "key" | "index";
}

/** What a `!ref` names: `<name>`, `<Alias>.<name>`, or a family member
 *  `<family>[<binding>.key|index]…`. `alias` is kept as written (`Self`
 *  included); a reader that treats `Self` as local says so itself. */
export interface ParsedRef {
  readonly alias?: string;
  readonly name: string;
  readonly indexes: readonly RefIndex[];
}

export const REF_MEMBER_INVALID = "REF_MEMBER_INVALID";

/** A `!ref` text outside the grammar, with the offset of its first inadmissible
 *  character. */
export interface RefRefusal {
  readonly code: typeof REF_MEMBER_INVALID;
  readonly offset: number;
}

export type RefVerdict = { parsed: ParsedRef } | { refusal: RefRefusal };

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

/**
 * The `!ref` grammar — its one reader. Three forms: `<name>`, `<Alias>.<name>`,
 * and `<family>` followed by one or more `[<binding>.key]` / `[<binding>.index]`.
 * Every name follows the identifier grammar, no whitespace is allowed and there
 * is no quoting rule inside the text; an alias with an index is refused.
 */
export function parseRefSource(source: string): RefVerdict {
  let pos = 0;
  const refuse = (offset: number): RefVerdict => ({
    refusal: { code: REF_MEMBER_INVALID, offset },
  });
  const identifier = (): string | undefined => {
    if (pos >= source.length || !IDENT_START.test(source[pos]!)) return undefined;
    const start = pos;
    pos++;
    while (pos < source.length && IDENT_PART.test(source[pos]!)) pos++;
    return source.slice(start, pos);
  };

  const head = identifier();
  if (head === undefined) return refuse(pos);
  if (pos === source.length) return { parsed: { name: head, indexes: [] } };

  if (source[pos] === ".") {
    pos++;
    const name = identifier();
    if (name === undefined) return refuse(pos);
    if (pos !== source.length) return refuse(pos);
    return { parsed: { alias: head, name, indexes: [] } };
  }

  const indexes: RefIndex[] = [];
  while (pos < source.length) {
    if (source[pos] !== "[") return refuse(pos);
    pos++;
    const binding = identifier();
    if (binding === undefined) return refuse(pos);
    if (source[pos] !== ".") return refuse(pos);
    pos++;
    const memberStart = pos;
    const member = identifier();
    if (member !== "key" && member !== "index") return refuse(memberStart);
    if (source[pos] !== "]") return refuse(pos);
    pos++;
    indexes.push({ binding, member });
  }
  return { parsed: { name: head, indexes } };
}

/** The sentence a refused `!ref` is reported with, naming where it goes wrong. */
export function refRefusalMessage(source: string, refusal: RefRefusal): string {
  const at =
    refusal.offset >= source.length
      ? "it ends too early"
      : `'${source[refusal.offset]}' at offset ${refusal.offset} is not allowed there`;
  return (
    `'!ref ${source}' is not a reference: ${at}. A reference is '<name>', '<Alias>.<name>', ` +
    `or '<family>[<binding>.key]' / '<family>[<binding>.index]' (one index per family depth, ` +
    `no alias), with no whitespace.`
  );
}

/** The `!ref` engine. Marks a tagged scalar as a resource reference; the loader
 *  attaches this engine's verdict ({@link parseRefSource}) to the sentinel, and
 *  every reader reads that verdict rather than the text.
 *
 *  Returns the source string verbatim at compile time. The lookup (sentinel →
 *  live ResourceInstance) happens at resource-context init; analysis is a no-op
 *  here, since reference resolution is the analyzer's. */
export const refEngine: TemplatingEngine = {
  name: "ref",

  compile(source) {
    return source;
  },

  analyze() {
    return { diagnostics: [], calls: [] };
  },
};
