/**
 * CEL's tokens.
 *
 * The lexer decodes literals as it reads them — a string token carries its text
 * with every escape resolved, a bytes token its bytes, an integer its magnitude as
 * a `bigint` — so nothing downstream re-reads source text to learn a value.
 *
 * It stops at the first thing it cannot read, reporting one diagnostic and ending
 * the token stream there. The parser then builds whatever the tokens before it
 * support, which is what leaves a half-typed expression usable.
 *
 * Three readings are deliberate, each pinned by the conformance vectors:
 *
 * - **Only a single-letter prefix** introduces a string: `r`, `R`, `b`, `B`. `br'x'`
 *   is the identifier `br` followed by a string, which no expression admits.
 * - **A raw string still lets a backslash take the next character with it**, keeping
 *   both as written, so `r'\''` is a backslash and a quote rather than an unclosed
 *   string.
 * - **A bytes literal holds the UTF-8 of its text.** `b'ÿ'` is `0xC3 0xBF`, two bytes,
 *   and an escape (`\xff`, `\303`) is the one byte it names. cel-spec's own answer, and
 *   the only reading under which `b'ÿ' == b'\303\277'` — a row — holds.
 *
 * A number never begins with `.`: `.5` is a dot and a number, and no expression
 * admits that either.
 */

import { wordReading } from "./reserved-words.js";
import { FirstSyntaxDiagnostic } from "./syntax-diagnostic.js";

export const MAX_INT = 9223372036854775807n;
export const MIN_INT = -9223372036854775808n;
export const MAX_UINT = 18446744073709551615n;

export type TokenType =
  /** A name, and a word read as a literal (`true`, `false`, `null`). */
  | "ident"
  /** A member name written between backticks, whatever it spells. */
  | "quotedIdent"
  /** A reserved word with no other reading: refused wherever a name is read. */
  | "reserved"
  /** An operator written as a word (`in`). */
  | "keyword"
  | "int"
  | "uint"
  | "double"
  | "string"
  | "bytes"
  | "punct"
  | "eof";

export interface Token {
  readonly type: TokenType;
  readonly start: number;
  readonly end: number;
  /** The lexeme, for `punct`; the name, for `ident` and `reserved`. */
  readonly text: string;
  readonly int?: bigint;
  readonly double?: number;
  readonly string?: string;
  readonly bytes?: Uint8Array;
  /**
   * An integer magnitude of exactly 2^63 — legal only directly under a unary
   * minus, which is how the int64 minimum is written.
   */
  readonly atIntBoundary?: boolean;
}

const PUNCTUATION = new Set(["(", ")", "[", "]", "{", "}", ".", ",", ":", "?", "!", "+", "-", "*", "/", "%"]);

const SIMPLE_ESCAPES = new Map<string, number>([
  ["\\", 0x5c],
  ["'", 0x27],
  ['"', 0x22],
  ["`", 0x60],
  ["?", 0x3f],
  ["a", 0x07],
  ["b", 0x08],
  ["f", 0x0c],
  ["n", 0x0a],
  ["r", 0x0d],
  ["t", 0x09],
  ["v", 0x0b],
]);

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}

function isOctalDigit(ch: string): boolean {
  return ch >= "0" && ch <= "7";
}

function isIdentStart(ch: string): boolean {
  return ch === "_" || (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

/**
 * What a word before a quote makes of the literal.
 *
 * cel-spec nests the two markers — `BYTES_LIT: [bB] STRING_LIT` over
 * `STRING_LIT: [rR]? (…)` — so the bytes marker comes first and `rb'…'` is not a
 * literal at all: it is the name `rb` beside a string, which no expression admits.
 */
function stringPrefix(text: string): { raw: boolean; bytes: boolean } | undefined {
  const lower = text.toLowerCase();
  if (lower === "r") return { raw: true, bytes: false };
  if (lower === "b") return { raw: false, bytes: true };
  if (lower === "br") return { raw: true, bytes: true };
  return undefined;
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

/** A decoded string or bytes literal, or nothing when it could not be read. */
interface LiteralText {
  readonly units: number[];
  readonly end: number;
}

export class Lexer {
  private at = 0;

  constructor(
    private readonly source: string,
    private readonly diagnostics: FirstSyntaxDiagnostic,
  ) {}

  /** Every token up to the end of the source, or up to the first unreadable text. */
  tokenize(): Token[] {
    const tokens: Token[] = [];
    for (;;) {
      this.skipIgnored();
      if (this.at >= this.source.length) {
        tokens.push(this.eof());
        return tokens;
      }
      const token = this.next();
      if (!token) {
        tokens.push(this.eof());
        return tokens;
      }
      tokens.push(token);
    }
  }

  private eof(): Token {
    return { type: "eof", start: this.at, end: this.at, text: "" };
  }

  private skipIgnored(): void {
    while (this.at < this.source.length) {
      const ch = this.source[this.at]!;
      if (isSpace(ch)) {
        this.at += 1;
        continue;
      }
      if (ch === "/" && this.source[this.at + 1] === "/") {
        while (this.at < this.source.length && this.source[this.at] !== "\n") this.at += 1;
        continue;
      }
      return;
    }
  }

  private next(): Token | undefined {
    const start = this.at;
    const ch = this.source[start]!;
    if (ch === "'" || ch === '"') return this.readQuoted(start, start, false, false);
    if (isIdentStart(ch)) return this.readWord(start);
    if (isDigit(ch)) return this.readNumber(start);
    // A double may begin with its point: cel-spec's FLOAT_LIT is `DIGIT* . DIGIT+`.
    if (ch === "." && isDigit(this.source[start + 1] ?? "")) return this.readNumber(start);
    if (ch === "`") return this.readQuotedIdentifier(start);
    return this.readPunctuation(start, ch);
  }

  private readPunctuation(start: number, ch: string): Token | undefined {
    const pair = this.source.slice(start, start + 2);
    if (pair === "==" || pair === "!=" || pair === "<=" || pair === ">=" || pair === "&&" || pair === "||") {
      this.at = start + 2;
      return { type: "punct", start, end: this.at, text: pair };
    }
    if (ch === "<" || ch === ">" || PUNCTUATION.has(ch)) {
      this.at = start + 1;
      return { type: "punct", start, end: this.at, text: ch };
    }
    this.diagnostics.report(
      "unexpected_character",
      `unexpected character ${JSON.stringify(ch)}`,
      start,
      start + 1,
    );
    this.at = start;
    return undefined;
  }

  /**
   * A member name between backticks. cel-spec's `ESCAPED_IDENTIFIER` takes no escapes
   * and cannot hold a backtick, so the text between them is the name as written.
   */
  private readQuotedIdentifier(start: number): Token | undefined {
    const close = this.source.indexOf("`", start + 1);
    if (close === -1 || this.source.slice(start + 1, close).includes("\n")) {
      this.diagnostics.report(
        "unterminated_string",
        "a quoted member name ends at its closing backtick",
        start,
        close === -1 ? this.source.length : close,
      );
      return undefined;
    }
    this.at = close + 1;
    return { type: "quotedIdent", start, end: this.at, text: this.source.slice(start + 1, close) };
  }

  /** An identifier, a literal word, or the prefix of a string literal. */
  private readWord(start: number): Token | undefined {
    let at = start;
    while (at < this.source.length && isIdentPart(this.source[at]!)) at += 1;
    const text = this.source.slice(start, at);
    const prefix = stringPrefix(text);
    if (prefix && (this.source[at] === "'" || this.source[at] === '"')) {
      return this.readQuoted(start, at, prefix.raw, prefix.bytes);
    }
    this.at = at;
    const reading = wordReading(text);
    const type = reading === "operator" ? "keyword" : reading === "refused" ? "reserved" : "ident";
    return { type, start, end: at, text };
  }

  private readNumber(start: number): Token | undefined {
    const source = this.source;
    let at = start;
    let kind: "int" | "double" = "int";
    let digits: string;
    let radix = 10;
    if (source[at] === "0" && (source[at + 1] === "x" || source[at + 1] === "X")) {
      at += 2;
      const from = at;
      while (at < source.length && isHexDigit(source[at]!)) at += 1;
      if (at === from) return this.invalidNumber(start, at);
      digits = source.slice(from, at);
      radix = 16;
    } else {
      const from = at;
      while (at < source.length && isDigit(source[at]!)) at += 1;
      if (source[at] === "." && isDigit(source[at + 1] ?? "")) {
        kind = "double";
        at += 1;
        while (at < source.length && isDigit(source[at]!)) at += 1;
      }
      if (source[at] === "e" || source[at] === "E") {
        let exponent = at + 1;
        if (source[exponent] === "+" || source[exponent] === "-") exponent += 1;
        if (isDigit(source[exponent] ?? "")) {
          kind = "double";
          at = exponent;
          while (at < source.length && isDigit(source[at]!)) at += 1;
        }
      }
      digits = source.slice(from, at);
    }

    const unsigned = source[at] === "u" || source[at] === "U";
    if (unsigned) at += 1;
    if (at < source.length && isIdentPart(source[at]!)) return this.invalidNumber(start, at);

    this.at = at;
    if (kind === "double") {
      if (unsigned) return this.invalidNumber(start, at);
      return { type: "double", start, end: at, text: source.slice(start, at), double: Number(digits) };
    }
    const magnitude = radix === 16 ? BigInt(`0x${digits}`) : BigInt(digits);
    if (unsigned) {
      if (magnitude > MAX_UINT) {
        this.diagnostics.report(
          "invalid_unsigned_integer",
          `${source.slice(start, at)} is outside the range of an unsigned 64-bit integer`,
          start,
          at,
        );
        return undefined;
      }
      return { type: "uint", start, end: at, text: source.slice(start, at), int: magnitude };
    }
    if (magnitude > -MIN_INT) {
      this.diagnostics.report(
        "invalid_integer",
        `${source.slice(start, at)} is outside the range of a 64-bit integer`,
        start,
        at,
      );
      return undefined;
    }
    return {
      type: "int",
      start,
      end: at,
      text: source.slice(start, at),
      int: magnitude,
      ...(magnitude === -MIN_INT ? { atIntBoundary: true } : {}),
    };
  }

  private invalidNumber(start: number, at: number): undefined {
    let end = at;
    while (end < this.source.length && isIdentPart(this.source[end]!)) end += 1;
    this.diagnostics.report(
      "invalid_number",
      `${this.source.slice(start, end)} is not a number`,
      start,
      end,
    );
    return undefined;
  }

  /**
   * A string or bytes literal. `start` is the literal's own start (its prefix, when
   * it has one) and `quoteAt` the opening quote.
   */
  private readQuoted(start: number, quoteAt: number, raw: boolean, bytes: boolean): Token | undefined {
    const quote = this.source[quoteAt]!;
    const triple = this.source.slice(quoteAt, quoteAt + 3) === quote.repeat(3);
    const terminator = triple ? quote.repeat(3) : quote;
    const decoded = raw
      ? this.scanRaw(quoteAt + terminator.length, terminator, triple, bytes)
      : this.scanEscaped(quoteAt + terminator.length, terminator, triple, bytes);
    if (!decoded) return undefined;
    this.at = decoded.end;
    const text = this.source.slice(start, decoded.end);
    if (bytes) {
      return { type: "bytes", start, end: decoded.end, text, bytes: Uint8Array.from(decoded.units) };
    }
    return { type: "string", start, end: decoded.end, text, string: textOf(decoded.units) };
  }

  private unterminated(start: number, at: number): undefined {
    this.diagnostics.report("unterminated_string", "unterminated string", start, at);
    return undefined;
  }

  /** A raw literal: a backslash takes the next character with it, both kept as written. */
  private scanRaw(
    from: number,
    terminator: string,
    triple: boolean,
    bytes: boolean,
  ): LiteralText | undefined {
    const source = this.source;
    const units: number[] = [];
    let at = from;
    while (at < source.length) {
      if (source.startsWith(terminator, at)) return { units, end: at + terminator.length };
      const ch = source[at]!;
      if (!triple && ch === "\n") break;
      if (ch === "\\" && at + 1 < source.length) {
        units.push(0x5c);
        at += 1 + this.literalCharacter(at + 1, bytes, units);
        continue;
      }
      at += this.literalCharacter(at, bytes, units);
    }
    return this.unterminated(from - terminator.length, at);
  }

  /**
   * One character of a literal's text, as the literal holds it: a code unit in a string,
   * the character's UTF-8 bytes in a bytes literal. Answers how many code units it read,
   * since a character outside the basic plane is written as a surrogate pair.
   */
  private literalCharacter(at: number, bytes: boolean, units: number[]): number {
    if (!bytes) {
      units.push(this.source.charCodeAt(at));
      return 1;
    }
    const point = this.source.codePointAt(at)!;
    pushUtf8(units, point);
    return point > 0xffff ? 2 : 1;
  }

  private scanEscaped(
    from: number,
    terminator: string,
    triple: boolean,
    bytes: boolean,
  ): LiteralText | undefined {
    const source = this.source;
    const units: number[] = [];
    let at = from;
    while (at < source.length) {
      if (source.startsWith(terminator, at)) return { units, end: at + terminator.length };
      const ch = source[at]!;
      if (!triple && ch === "\n") break;
      if (ch !== "\\") {
        at += this.literalCharacter(at, bytes, units);
        continue;
      }
      const next = this.readEscape(at, bytes, units);
      if (next === undefined) return undefined;
      at = next;
    }
    return this.unterminated(from - terminator.length, at);
  }

  /** Decodes one escape sequence onto `units`, answering where it ends. */
  private readEscape(at: number, bytes: boolean, units: number[]): number | undefined {
    const source = this.source;
    const ch = source[at + 1];
    if (ch === undefined) {
      this.diagnostics.report("invalid_escape_sequence", "the escape has no character", at, at + 1);
      return undefined;
    }
    const simple = SIMPLE_ESCAPES.get(ch);
    if (simple !== undefined) {
      units.push(simple);
      return at + 2;
    }
    if (ch === "x" || ch === "X") return this.readHexEscape(at, units);
    if (ch === "u" || ch === "U") {
      if (bytes) {
        this.diagnostics.report(
          "bytes_unicode_escape",
          `\\${ch} names text, which a bytes literal cannot hold — write the bytes with \\x`,
          at,
          at + 2,
        );
        return undefined;
      }
      return this.readUnicodeEscape(at, ch === "u" ? 4 : 8, units);
    }
    if (isOctalDigit(ch)) return this.readOctalEscape(at, units);
    this.diagnostics.report(
      "invalid_escape_sequence",
      `\\${ch} is not an escape sequence`,
      at,
      at + 2,
    );
    return undefined;
  }

  private readHexEscape(at: number, units: number[]): number | undefined {
    const digits = this.source.slice(at + 2, at + 4);
    if (digits.length < 2 || !isHexDigit(digits[0]!) || !isHexDigit(digits[1]!)) {
      this.diagnostics.report("invalid_hex_escape", "a \\x escape takes two hexadecimal digits", at, at + 4);
      return undefined;
    }
    units.push(Number.parseInt(digits, 16));
    return at + 4;
  }

  private readOctalEscape(at: number, units: number[]): number | undefined {
    const digits = this.source.slice(at + 1, at + 4);
    if (digits.length < 3 || ![...digits].every(isOctalDigit)) {
      this.diagnostics.report("invalid_octal_escape", "an octal escape takes three octal digits", at, at + 4);
      return undefined;
    }
    const value = Number.parseInt(digits, 8);
    if (value > 0xff) {
      this.diagnostics.report("octal_escape_out_of_range", `\\${digits} is above 255`, at, at + 4);
      return undefined;
    }
    units.push(value);
    return at + 4;
  }

  private readUnicodeEscape(at: number, width: number, units: number[]): number | undefined {
    const digits = this.source.slice(at + 2, at + 2 + width);
    if (digits.length < width || ![...digits].every(isHexDigit)) {
      this.diagnostics.report(
        "invalid_unicode_escape",
        `a \\${width === 4 ? "u" : "U"} escape takes ${width} hexadecimal digits`,
        at,
        at + 2 + width,
      );
      return undefined;
    }
    const point = Number.parseInt(digits, 16);
    const end = at + 2 + width;
    if (point > 0x10ffff) {
      this.diagnostics.report("invalid_unicode_escape", `U+${digits} is not a code point`, at, end);
      return undefined;
    }
    if (point >= 0xdc00 && point <= 0xdfff) {
      this.diagnostics.report("invalid_unicode_surrogate", `U+${digits} is a trailing surrogate`, at, end);
      return undefined;
    }
    if (point >= 0xd800 && point <= 0xdbff) return this.readSurrogatePair(at, end, point, units);
    if (point > 0xffff) {
      units.push(0xd800 + ((point - 0x10000) >> 10), 0xdc00 + ((point - 0x10000) & 0x3ff));
      return end;
    }
    units.push(point);
    return end;
  }

  /** A leading surrogate stands only beside the trailing one that completes it. */
  private readSurrogatePair(at: number, end: number, lead: number, units: number[]): number | undefined {
    const follows = this.source.slice(end, end + 6);
    const trail = /^\\u([0-9a-fA-F]{4})$/.exec(follows);
    const point = trail ? Number.parseInt(trail[1]!, 16) : 0;
    if (!trail || point < 0xdc00 || point > 0xdfff) {
      this.diagnostics.report(
        "invalid_unicode_surrogate",
        "a leading surrogate must be followed by a trailing surrogate escape",
        at,
        end,
      );
      return undefined;
    }
    units.push(lead, point);
    return end + 6;
  }
}

/** The UTF-8 bytes of one code point, which is what a bytes literal holds of its text. */
function pushUtf8(units: number[], point: number): void {
  if (point < 0x80) {
    units.push(point);
    return;
  }
  if (point < 0x800) {
    units.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    return;
  }
  if (point < 0x10000) {
    units.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    return;
  }
  units.push(
    0xf0 | (point >> 18),
    0x80 | ((point >> 12) & 0x3f),
    0x80 | ((point >> 6) & 0x3f),
    0x80 | (point & 0x3f),
  );
}

/** Code units to text, in chunks so that a long literal does not exhaust the stack. */
function textOf(units: readonly number[]): string {
  if (units.length <= 4096) return String.fromCharCode(...units);
  let text = "";
  for (let at = 0; at < units.length; at += 4096) {
    text += String.fromCharCode(...units.slice(at, at + 4096));
  }
  return text;
}

/** Every token of the source, with at most one diagnostic for where it stopped. */
export function tokenize(source: string): { tokens: Token[]; diagnostics: FirstSyntaxDiagnostic } {
  const diagnostics = new FirstSyntaxDiagnostic();
  const tokens = new Lexer(source, diagnostics).tokenize();
  return { tokens, diagnostics };
}
