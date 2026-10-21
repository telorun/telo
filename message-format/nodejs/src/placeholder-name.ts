/**
 * A placeholder name, and a selection's selector, follow the Telo name rule: a letter
 * or `_`, then letters, digits or `_`, and not one of CEL's 21 reserved words.
 */

const RESERVED_WORDS: ReadonlySet<string> = new Set([
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
]);

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Why `name` cannot name a placeholder, or `null` when it can. */
export function placeholderNameRefusal(name: string): string | null {
  if (!NAME.test(name)) {
    return `${name} is not a name: a name starts with a letter or _ and continues with letters, digits or _`;
  }
  if (RESERVED_WORDS.has(name)) return `${name} is a reserved word and cannot name a placeholder`;
  return null;
}
