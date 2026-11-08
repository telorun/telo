import { describe, expect, it } from "vitest";
import { quotedLiteralEnd, tokenize } from "../src/lexer.js";

const ALPHABET = ["r", "R", "b", "B", "x", "1", "_", "'", '"', "`", "\\", "\n", "\r", "a"];

/** Sources the lexer tests read, which reach past length 5. */
const LEXER_SOURCES = [
  "''",
  '"a"',
  "'''a\nb'''",
  '"""a"b"""',
  'r"\\n"',
  "R'a\\'b'",
  "r''''''",
  '"\\\\ \\? \\" \\\' \\` \\a \\b \\f \\n \\r \\t \\v"',
  '"\\u270c \\U0001f431 \\ud83d\\udc31"',
  "b'\\000\\xff'",
  "b'ÿ'",
  "b'\u{1f431}'",
  "br'\\n'",
  'bR"\\n"',
  "'abc",
  "'a\nb'",
  "'a\rb'",
  "rb'x'",
  "`a`",
  "`a",
  "a.`b\rc`",
  "r'a\\\nb'",
  "br'a\\\rb'",
  "r'abc\\",
  "r'\\''",
  "r'''a\\'''b'''",
  "r'''a\\\rb'''",
  "'''a\r\nb'''",
  "m.`it's}}`",
  "'\u{1f600}' + b'\u{1f600}'",
];

function* strings(maxLength: number): Generator<string> {
  let layer = [""];
  for (let length = 1; length <= maxLength; length++) {
    const next: string[] = [];
    for (const prefix of layer) {
      for (const ch of ALPHABET) {
        const source = prefix + ch;
        next.push(source);
        yield source;
      }
    }
    layer = next;
  }
}

/** The disagreements between the function and the lexer over one source. */
function disagreements(source: string): string[] {
  const found: string[] = [];
  const { tokens, diagnostics } = tokenize(source);
  for (const token of tokens) {
    if (token.type !== "string" && token.type !== "bytes" && token.type !== "quotedIdent") continue;
    const quoteAt = token.type === "quotedIdent" ? token.start : token.text.search(/['"]/) + token.start;
    const end = quotedLiteralEnd(source, quoteAt);
    if (end !== token.end) found.push(`${JSON.stringify(source)}: token ends ${token.end}, function ${end}`);
  }
  const diagnostic = diagnostics.first;
  if (diagnostic?.code === "unterminated_string") {
    const end = quotedLiteralEnd(source, diagnostic.range[0]);
    if (end !== undefined) found.push(`${JSON.stringify(source)}: unterminated, function ${end}`);
  }
  return found;
}

describe("quotedLiteralEnd", () => {
  it("agrees with the lexer on every source up to length 5 and on the lexer's own sources", () => {
    const found: string[] = [];
    let count = 0;
    for (const source of [...LEXER_SOURCES, ...strings(5)]) {
      count += 1;
      found.push(...disagreements(source));
      if (found.length > 20) break;
    }
    expect(found).toEqual([]);
    expect(count).toBe(LEXER_SOURCES.length + 579194);
  }, 120000);

  it("delimits a literal the lexer refuses for an escape where the language ends it", () => {
    expect([
      quotedLiteralEnd("'\\q'", 0),
      quotedLiteralEnd("'a\\\nb'", 0),
      quotedLiteralEnd("'a\\\rb'", 0),
      quotedLiteralEnd("b'\\u0041'", 1),
      quotedLiteralEnd("'\\", 0),
    ]).toEqual([4, 6, 6, 9, undefined]);
  });

  // Blind spot: the enumeration cannot tell a raw from a plain literal where the lexer stops on
  // invalid_escape_sequence, so these rows hold the prefix rule (a backslash before a line break).
  it("holds the prefix rule where a raw and a plain literal end differently", () => {
    expect([
      quotedLiteralEnd("rb'\\\n'", 2),
      quotedLiteralEnd("x'\\\n'", 1),
      quotedLiteralEnd("bR'\\\n'", 2),
      quotedLiteralEnd("Br'\\\n'", 2),
      quotedLiteralEnd("BR'\\\n'", 2),
    ]).toEqual([6, 5, undefined, undefined, undefined]);
  });

  it("is a caller defect to ask at a character that opens no literal", () => {
    expect(() => quotedLiteralEnd("abc", 1)).toThrow("holds no quote");
  });
});
