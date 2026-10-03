/**
 * Where a text stops being a prefix of any RFC 8259 JSON text.
 *
 * It is the offset `parseJson`'s refusal names, and it is computed here so the wording
 * is the catalog's own and never the host JSON parser's: the host's verdict decides
 * WHETHER a text is JSON, and this scan decides only how the refusal reads. A text the
 * host refused and this scan reads as JSON is a defect here, raised as one with the
 * host's error as its cause (`catalog-runtime.ts`).
 *
 * Its agreement with RFC 8259 is a property of the scan, never asserted at runtime. What
 * holds it here is the catalog's own conformance rows, which pin the offset of thirteen
 * refusals — a mid-text one, an end-of-input one, a bad escape, a leading zero, a byte-order
 * mark and a raw control character among them. What those rows cannot reach is a text no row
 * writes: the scan's agreement over arbitrary input was measured by differential fuzzing
 * against the host parser where it was first written, and that measurement travels with the
 * suite that made it rather than with this copy.
 */
export interface JsonRefusal {
  /** UTF-16 offset of the first offending code unit; the text's length when
   *  every prefix is viable and the text is merely incomplete. */
  readonly offset: number;
  readonly endOfInput: boolean;
}

type ScanState = "value" | "valueOrClose" | "key" | "keyOrClose" | "after";

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const SIMPLE_ESCAPES = '"\\/bfnrt';

const isWhitespace = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
const isHexDigit = (c: string): boolean => isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");

/** The refusal of `text`, or `undefined` when it is a JSON text. Iterative, so
 *  nesting depth is bounded by memory rather than by the call stack. Neither
 *  stricter nor laxer than RFC 8259. */
export function scanJsonPrefix(text: string): JsonRefusal | undefined {
  const length = text.length;
  let at = 0;

  // Each token reader returns the offset it refuses, or `undefined` once `at`
  // is past the token.
  const readString = (): number | undefined => {
    at++;
    for (;;) {
      if (at >= length) return length;
      const code = text.charCodeAt(at);
      if (code === QUOTE) {
        at++;
        return undefined;
      }
      if (code < 0x20) return at;
      at++;
      if (code !== BACKSLASH) continue;
      if (at >= length) return length;
      const escape = text[at]!;
      if (escape === "u") {
        at++;
        for (let digit = 0; digit < 4; digit++, at++) {
          if (at >= length) return length;
          if (!isHexDigit(text[at]!)) return at;
        }
      } else if (SIMPLE_ESCAPES.includes(escape)) at++;
      else return at;
    }
  };

  const readDigits = (): number | undefined => {
    if (!isDigit(text[at])) return at;
    while (isDigit(text[at])) at++;
    return undefined;
  };

  const readNumber = (): number | undefined => {
    if (text[at] === "-") at++;
    if (text[at] === "0") at++;
    else {
      const refused = readDigits();
      if (refused !== undefined) return refused;
    }
    if (text[at] === ".") {
      at++;
      const refused = readDigits();
      if (refused !== undefined) return refused;
    }
    if (text[at] === "e" || text[at] === "E") {
      at++;
      if (text[at] === "+" || text[at] === "-") at++;
      return readDigits();
    }
    return undefined;
  };

  const readLiteral = (literal: string): number | undefined => {
    for (const expected of literal) {
      if (text[at] !== expected) return at;
      at++;
    }
    return undefined;
  };

  const refusedAt = (offset: number): JsonRefusal => ({ offset, endOfInput: offset >= length });

  const open: ("{" | "[")[] = [];
  let state: ScanState = "value";
  for (;;) {
    while (isWhitespace(text[at])) at++;
    const c = text[at];

    if (state === "after") {
      const container = open[open.length - 1];
      if (container === undefined) return at === length ? undefined : refusedAt(at);
      if (c === ",") {
        at++;
        state = container === "{" ? "key" : "value";
      } else if (c === (container === "{" ? "}" : "]")) {
        at++;
        open.pop();
      } else return refusedAt(at);
      continue;
    }

    if (state === "key" || state === "keyOrClose") {
      if (state === "keyOrClose" && c === "}") {
        at++;
        open.pop();
        state = "after";
        continue;
      }
      if (c !== '"') return refusedAt(at);
      const refused = readString();
      if (refused !== undefined) return refusedAt(refused);
      while (isWhitespace(text[at])) at++;
      if (text[at] !== ":") return refusedAt(at);
      at++;
      state = "value";
      continue;
    }

    if (state === "valueOrClose" && c === "]") {
      at++;
      open.pop();
      state = "after";
      continue;
    }
    if (c === "{" || c === "[") {
      at++;
      open.push(c);
      state = c === "{" ? "keyOrClose" : "valueOrClose";
      continue;
    }
    let refused: number | undefined;
    if (c === '"') refused = readString();
    else if (c === "-" || isDigit(c)) refused = readNumber();
    else if (c === "t") refused = readLiteral("true");
    else if (c === "f") refused = readLiteral("false");
    else if (c === "n") refused = readLiteral("null");
    else refused = at;
    if (refused !== undefined) return refusedAt(refused);
    state = "after";
  }
}
