/**
 * What the front end says when it cannot read the source.
 *
 * A syntax diagnostic is DATA, never a thrown error and never a sentence a
 * consumer re-derives: it carries a code from the closed set below, the range of
 * the offending text, and a message for a reader. Parsing reports **at most one**
 * — the first thing it could not read, in source order — because the text after it
 * is no longer trustworthy and a cascade of guesses is what makes a half-typed
 * expression unusable in an editor. Everything the parser could read is still in
 * the tree.
 *
 * Every range lies within the source and splits no character.
 */

export type CelSyntaxCode =
  /** A character that begins no CEL token. */
  | "unexpected_character"
  /** A token that cannot stand where it does. */
  | "unexpected_token"
  /** The source ended with an expression unfinished. */
  | "unexpected_end"
  /** A string or bytes literal that no quote closes. */
  | "unterminated_string"
  /** A reserved word written where an identifier must be. */
  | "reserved_identifier"
  /** A number literal that is not spelled as one. */
  | "invalid_number"
  /** An integer literal outside the int64 range. */
  | "invalid_integer"
  /** An unsigned integer literal outside the uint64 range. */
  | "invalid_unsigned_integer"
  /** An escape sequence no string or bytes literal admits. */
  | "invalid_escape_sequence"
  /** A `\\u`/`\\U` escape naming no Unicode code point. */
  | "invalid_unicode_escape"
  /** A `\\u` escape naming a surrogate not paired with its partner. */
  | "invalid_unicode_surrogate"
  /** A `\\x`/`\\X` escape with fewer than two hexadecimal digits. */
  | "invalid_hex_escape"
  /** A `\\nnn` escape with fewer than three octal digits. */
  | "invalid_octal_escape"
  /** A `\\nnn` escape naming a value above 255. */
  | "octal_escape_out_of_range"
  /** A `\\u`/`\\U` escape inside a bytes literal, which holds bytes and not text. */
  | "bytes_unicode_escape"
  /** One of the five input limits was reached. */
  | "limit_exceeded";

export interface CelSyntaxDiagnostic {
  readonly code: CelSyntaxCode;
  readonly message: string;
  readonly range: readonly [start: number, end: number];
}

/**
 * Collects the first diagnostic reported to it and ignores every later one. The lexer
 * and the parser each hold one, and `firstInSourceOrder` decides between the two.
 */
export class FirstSyntaxDiagnostic {
  private held: CelSyntaxDiagnostic | undefined;

  report(code: CelSyntaxCode, message: string, start: number, end: number): void {
    this.held ??= { code, message, range: [start, end] };
  }

  get first(): CelSyntaxDiagnostic | undefined {
    return this.held;
  }
}

/**
 * The one diagnostic of a read whose lexer stopped at `cut`, the offset where the text
 * it could not read begins. The parser read the source cut there, so what it reports
 * before the cut came first; from the cut on, the unreadable text is the cause.
 */
export function firstInSourceOrder(
  lexed: CelSyntaxDiagnostic | undefined,
  parsed: CelSyntaxDiagnostic | undefined,
  cut: number,
): readonly CelSyntaxDiagnostic[] {
  if (lexed && parsed) return [parsed.range[0] < cut ? parsed : lexed];
  const only = lexed ?? parsed;
  return only ? [only] : [];
}
