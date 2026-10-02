/**
 * The words no CEL identifier may be: cel-spec's `RESERVED` production, which its
 * `IDENT` production excludes. All 21 of them.
 *
 * The set is frozen deliberately: a word added here stops a manifest that uses it as
 * a variable or a function name from parsing, so it is widened only with a
 * deprecation behind it.
 *
 * **Three of the 21 are refused by being read as something else**, and the
 * distinction is the lexer's whole policy about words, so it lives here rather than
 * there. `true`, `false` and `null` are literals; `in` is the membership operator.
 * Neither reading can be reached from a name position, which is why cel-spec needs
 * them in `RESERVED` and why an engine must not quietly accept one as a name — doing
 * so breaks the premise every consumer of the set is written against.
 *
 * **A reserved word is refused as an IDENTIFIER, not as a member name.** CEL's own
 * conformance suite reads `{'let': 1}.let` and `a.while()`; `a.in` and `a.true` are
 * the same position, and read for the same reason. A member name is a name of a
 * value's entry, not a name in the expression's scope.
 *
 * **No host's property names are here.** A member *name* is written by the author; a
 * member *key* can come from a request (`a[request.query.k]`), so a word list cannot
 * be what keeps a host's property out of a CEL value — it does not touch the computed
 * form at all. That guarantee belongs to the member-read operation, which resolves
 * every form against the value's own entries and never performs a host property read.
 * `constructor` never being on any such list is the same point made by its absence.
 *
 * `cel` and `optional` are legal identifiers, reserved only against being registered
 * as a namespace (`namespace-resolution.ts`), because the standard macros are written
 * on them (`cel.bind`, `optional.of`).
 */

export const RESERVED_WORDS: readonly string[] = [
  "as",
  "break",
  "const",
  "continue",
  "else",
  "false",
  "for",
  "function",
  "if",
  "import",
  "in",
  "let",
  "loop",
  "namespace",
  "null",
  "package",
  "return",
  "true",
  "var",
  "void",
  "while",
];

/** The reserved words that are a literal where they stand. */
export const LITERAL_WORDS: readonly string[] = ["true", "false", "null"];

/** The reserved words that are an operator where they stand. */
export const OPERATOR_WORDS: readonly string[] = ["in"];

const RESERVED = new Set(RESERVED_WORDS);
const LITERALS = new Set(LITERAL_WORDS);
const OPERATORS = new Set(OPERATOR_WORDS);

/** How a word is read where an expression begins. */
export type WordReading =
  /** An ordinary identifier. */
  | "name"
  /** A literal value: `true`, `false`, `null`. */
  | "literal"
  /** An operator written as a word: `in`. */
  | "operator"
  /** Reserved, with no other reading — refused wherever a name is read. */
  | "refused";

export function wordReading(text: string): WordReading {
  if (LITERALS.has(text)) return "literal";
  if (OPERATORS.has(text)) return "operator";
  return RESERVED.has(text) ? "refused" : "name";
}

/** Whether the word is one cel-spec reserves, however it is read. */
export function isReservedWord(name: string): boolean {
  return RESERVED.has(name);
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether the text is spelled as a CEL identifier, reserved or not. */
export function isIdentifierSpelling(text: string): boolean {
  return IDENTIFIER.test(text);
}
