/**
 * The `message-pattern` profile: MessageFormat 2's `pattern` production limited to
 * literal text, variable placeholders `{$name}` and the escapes `\{`, `\}`, `\\`.
 *
 * Inside braces MF2's optional whitespace and bidi marks are accepted (`{ $n }`,
 * `{$‎n‏}`), so every pattern of the profile is an MF2 pattern written the
 * way MF2 allows; the canonical form drops them. Anything else MF2 can write in braces
 * — a literal, a function, an option, an attribute, markup — is outside the profile.
 */

import type { Pattern, PatternPart } from "./message-model.js";
import { syntaxProblem, type MessageProblem } from "./message-problem.js";
import { placeholderNameRefusal } from "./placeholder-name.js";

export type PatternResult =
  | { readonly ok: true; readonly pattern: Pattern }
  | { readonly ok: false; readonly problem: MessageProblem };

const WHITESPACE: ReadonlySet<number> = new Set([0x20, 0x09, 0x0d, 0x0a, 0x3000]);
const BIDI: ReadonlySet<number> = new Set([0x061c, 0x200e, 0x200f, 0x2066, 0x2067, 0x2068, 0x2069]);
const BACKSLASH = 0x5c;
const OPEN = 0x7b;
const CLOSE = 0x7d;
const DOLLAR = 0x24;

export function parsePattern(source: string): PatternResult {
  return parsePatternAt(source, []);
}

/** Code units the character at `at` takes: two for a surrogate pair, else one. */
function widthAt(source: string, at: number): number {
  const unit = source.charCodeAt(at);
  if (unit >= 0xd800 && unit <= 0xdbff && at + 1 < source.length) {
    const next = source.charCodeAt(at + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return 2;
  }
  return 1;
}

function isLoneSurrogate(source: string, at: number): boolean {
  const unit = source.charCodeAt(at);
  return unit >= 0xd800 && unit <= 0xdfff && widthAt(source, at) === 1;
}

export function parsePatternAt(source: string, path: readonly string[]): PatternResult {
  const fail = (message: string, start: number, end: number): PatternResult => ({
    ok: false,
    problem: syntaxProblem(message, path, { start, end }),
  });
  const parts: PatternPart[] = [];
  let text = "";
  let at = 0;
  const skipOptional = (): void => {
    while (at < source.length && (WHITESPACE.has(source.charCodeAt(at)) || BIDI.has(source.charCodeAt(at)))) at += 1;
  };

  while (at < source.length) {
    const unit = source.charCodeAt(at);
    if (unit === BACKSLASH) {
      if (at + 1 >= source.length) return fail("a \\ at the end of the text escapes nothing", at, at + 1);
      const next = source.charCodeAt(at + 1);
      if (next === BACKSLASH || next === OPEN || next === CLOSE) {
        text += source[at + 1];
        at += 2;
        continue;
      }
      const width = widthAt(source, at + 1);
      return fail(
        `\\${source.slice(at + 1, at + 1 + width)} is not an escape: text escapes only \\{, \\} and \\\\`,
        at,
        at + 1 + width,
      );
    }
    if (unit === CLOSE) return fail("a } in text is written \\}", at, at + 1);
    if (unit === 0) return fail("U+0000 cannot appear in a message", at, at + 1);
    if (isLoneSurrogate(source, at)) return fail("an unpaired surrogate cannot appear in a message", at, at + 1);
    if (unit !== OPEN) {
      const width = widthAt(source, at);
      text += source.slice(at, at + width);
      at += width;
      continue;
    }

    const open = at;
    at += 1;
    skipOptional();
    if (at >= source.length) return fail("the placeholder is not closed", open, source.length);
    if (source.charCodeAt(at) !== DOLLAR) {
      return fail("a placeholder is written {$name}", open, at + widthAt(source, at));
    }
    const dollar = at;
    at += 1;
    if (at < source.length && BIDI.has(source.charCodeAt(at))) at += 1;
    const nameStart = at;
    while (at < source.length) {
      const next = source.charCodeAt(at);
      if (WHITESPACE.has(next) || BIDI.has(next) || next === OPEN || next === CLOSE) break;
      at += widthAt(source, at);
    }
    const name = source.slice(nameStart, at);
    if (name === "") return fail("$ must be followed by a placeholder name", dollar, dollar + 1);
    const refusal = placeholderNameRefusal(name);
    if (refusal !== null) return fail(refusal, nameStart, at);
    skipOptional();
    if (at >= source.length) return fail("the placeholder is not closed", open, source.length);
    if (source.charCodeAt(at) !== CLOSE) {
      return fail("a placeholder holds only its $name", at, at + widthAt(source, at));
    }
    at += 1;
    if (text !== "") parts.push(text);
    text = "";
    parts.push({ placeholder: name });
  }
  if (text !== "") parts.push(text);
  return { ok: true, pattern: parts };
}
