import { describe, expect, it } from "vitest";
import { parseSyntax } from "../src/parser.js";
import type { CelSyntaxDiagnostic } from "../src/syntax-diagnostic.js";
import type { CelLiteral } from "../src/syntax-tree.js";

/** The literal a source of exactly one literal reads as. */
function literalOf(source: string): CelLiteral {
  const parsed = parseSyntax(source);
  expect(parsed.diagnostics, source).toEqual([]);
  if (parsed.root.kind !== "literal") throw new Error(`${source} is not one literal`);
  return parsed.root.literal;
}

/** The one diagnostic of a source that is refused, whole. */
function diagnosed(source: string): CelSyntaxDiagnostic {
  const parsed = parseSyntax(source);
  expect(parsed.diagnostics, source).toHaveLength(1);
  return parsed.diagnostics[0]!;
}

function refusal(source: string): { code: string; range: readonly [number, number] } {
  const parsed = parseSyntax(source);
  const diagnostic = parsed.diagnostics[0];
  if (!diagnostic) throw new Error(`${source} was not refused`);
  expect(parsed.diagnostics).toHaveLength(1);
  return { code: diagnostic.code, range: diagnostic.range };
}

describe("the literal grammar", () => {
  it("reads every numeric form with its own type", () => {
    expect([
      literalOf("0"),
      literalOf("9223372036854775807"),
      literalOf("-9223372036854775808"),
      literalOf("0xFF"),
      literalOf("42u"),
      literalOf("0xFFU"),
      literalOf("18446744073709551615u"),
      literalOf("1.0"),
      literalOf("1e3"),
      literalOf("1.5e-3"),
      literalOf(".99"),
      literalOf("-0.0"),
    ]).toEqual([
      { type: "int", value: 0n },
      { type: "int", value: 9223372036854775807n },
      { type: "int", value: -9223372036854775808n },
      { type: "int", value: 255n },
      { type: "uint", value: 42n },
      { type: "uint", value: 255n },
      { type: "uint", value: 18446744073709551615n },
      { type: "double", value: 1 },
      { type: "double", value: 1000 },
      { type: "double", value: 0.0015 },
      { type: "double", value: 0.99 },
      { type: "double", value: -0 },
    ]);
  });

  it("refuses a number outside its type's range", () => {
    expect([refusal("9223372036854775808").code, refusal("18446744073709551616u").code]).toEqual([
      "invalid_integer",
      "invalid_unsigned_integer",
    ]);
  });

  it("reads every quoting, every prefix and every escape form", () => {
    expect([
      literalOf("''"),
      literalOf('"a"'),
      literalOf("'''a\nb'''"),
      literalOf('"""a"b"""'),
      literalOf('r"\\n"'),
      literalOf("R'a\\'b'"),
      literalOf("r''''''"),
      literalOf('"\\\\ \\? \\" \\\' \\` \\a \\b \\f \\n \\r \\t \\v"'),
      literalOf('"\\x41 \\X41 \\101"'),
      literalOf('"\\u270c \\U0001f431 \\ud83d\\udc31"'),
      literalOf("true"),
      literalOf("false"),
      literalOf("null"),
    ]).toEqual([
      { type: "string", value: "" },
      { type: "string", value: "a" },
      { type: "string", value: "a\nb" },
      { type: "string", value: 'a"b' },
      { type: "string", value: "\\n" },
      { type: "string", value: "a\\'b" },
      { type: "string", value: "" },
      { type: "string", value: "\\ ? \" ' ` \u0007 \b \f \n \r \t \v" },
      { type: "string", value: "A A A" },
      { type: "string", value: "✌ \u{1f431} \u{1f431}" },
      { type: "bool", value: true },
      { type: "bool", value: false },
      { type: "null" },
    ]);
  });

  it("reads a bytes literal as the UTF-8 of its text, an escape as the byte it names", () => {
    expect([
      literalOf('b""'),
      literalOf("b'\\000\\xff'"),
      literalOf("b'ÿ'"),
      literalOf("b'\u{1f431}'"),
      literalOf("B'ab'"),
      literalOf("br'\\n'"),
      literalOf('bR"\\n"'),
    ]).toEqual([
      { type: "bytes", value: new Uint8Array() },
      { type: "bytes", value: new Uint8Array([0, 255]) },
      { type: "bytes", value: new Uint8Array([0xc3, 0xbf]) },
      { type: "bytes", value: new Uint8Array([0xf0, 0x9f, 0x90, 0xb1]) },
      { type: "bytes", value: new Uint8Array([97, 98]) },
      { type: "bytes", value: new Uint8Array([92, 110]) },
      { type: "bytes", value: new Uint8Array([92, 110]) },
    ]);
  });

  it("refuses an unreadable literal where it goes wrong", () => {
    expect([
      refusal("'abc"),
      refusal("'a\nb'"),
      refusal('"\\q"'),
      refusal('"\\x4"'),
      refusal('"\\77"'),
      refusal('"\\400"'),
      refusal('"\\ud83d"'),
      refusal('"\\U00110000"'),
      refusal("b'\\u0041'"),
      refusal("`a`"),
      refusal("rb'x'"),
      refusal("`a"),
    ]).toEqual([
      { code: "unterminated_string", range: [0, 4] },
      { code: "unterminated_string", range: [0, 2] },
      { code: "invalid_escape_sequence", range: [1, 3] },
      { code: "invalid_hex_escape", range: [1, 4] },
      { code: "invalid_octal_escape", range: [1, 4] },
      { code: "octal_escape_out_of_range", range: [1, 5] },
      { code: "invalid_unicode_surrogate", range: [1, 7] },
      { code: "invalid_unicode_escape", range: [1, 11] },
      { code: "bytes_unicode_escape", range: [2, 4] },
      { code: "unexpected_token", range: [0, 3] },
      { code: "unexpected_token", range: [2, 5] },
      { code: "unterminated_string", range: [0, 2] },
    ]);
  });

  it("ranges an escape as it is written, not by the width it should have had", () => {
    expect([
      refusal('"\\x'),
      refusal('"\\0'),
      refusal('"\\u'),
      refusal('"\\U'),
      refusal("'abc\\x4"),
      refusal("b'\\7"),
      refusal("'\\x4'"),
      refusal("'\\xZZ'"),
      refusal("'\\x4\u{1f600}'"),
      refusal("'\\u12G4'"),
    ]).toEqual([
      { code: "invalid_hex_escape", range: [1, 3] },
      { code: "invalid_octal_escape", range: [1, 3] },
      { code: "invalid_unicode_escape", range: [1, 3] },
      { code: "invalid_unicode_escape", range: [1, 3] },
      { code: "invalid_hex_escape", range: [4, 7] },
      { code: "invalid_octal_escape", range: [2, 4] },
      { code: "invalid_hex_escape", range: [1, 4] },
      { code: "invalid_hex_escape", range: [1, 3] },
      { code: "invalid_hex_escape", range: [1, 4] },
      { code: "invalid_unicode_escape", range: [1, 5] },
    ]);
  });

  it("reports a character outside the basic plane whole", () => {
    expect([diagnosed("\u{1f600}"), diagnosed("a + \u{1f600}")]).toEqual([
      { code: "unexpected_character", message: 'unexpected character "\u{1f600}"', range: [0, 2] },
      { code: "unexpected_character", message: 'unexpected character "\u{1f600}"', range: [4, 6] },
    ]);
  });

  it("names and ranges the whole character an escape stands before", () => {
    const message = "\\\u{1f600} is not an escape sequence";
    expect([diagnosed('"\\\u{1f600}"'), diagnosed("'a\\\u{1f600}b'"), diagnosed("b'\\\u{1f600}'")]).toEqual([
      { code: "invalid_escape_sequence", message, range: [1, 4] },
      { code: "invalid_escape_sequence", message, range: [2, 5] },
      { code: "invalid_escape_sequence", message, range: [2, 5] },
    ]);
  });

  it("ends a single-line raw literal at a line feed, a backslash before it or not", () => {
    expect([diagnosed("r'a\\\nb'"), diagnosed("br'a\\\nb'"), diagnosed("r'abc\\")]).toEqual([
      { code: "unterminated_string", message: "unterminated string", range: [1, 4] },
      { code: "unterminated_string", message: "unterminated string", range: [2, 5] },
      { code: "unterminated_string", message: "unterminated string", range: [1, 6] },
    ]);
    // Any other character still goes with the backslash, and a triple-quoted one takes the line feed.
    expect([literalOf("r'\\''"), literalOf("r'''a\\'''b'''"), literalOf("r'''a\\\nb'''")]).toEqual([
      { type: "string", value: "\\'" },
      { type: "string", value: "a\\'''b" },
      { type: "string", value: "a\\\nb" },
    ]);
  });
});
