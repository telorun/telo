/** The Node checker for the `re2-pattern` Telo format: a regular expression
 *  RE2 and an ECMAScript `u`-mode engine both accept and match identically.
 *
 *  The grammar is a CLOSED allowlist read by one recursive-descent pass; any
 *  construct outside it is refused by name with its offset, never compiled to
 *  find out. What each engine reads differently — `.` and `\s` / `\S` match a
 *  different set, `\u` / `\x{…}` / `\cX` / octal are one engine's spelling —
 *  is outside it, as is everything RE2 lacks (lookaround, backreferences) and
 *  everything ECMAScript lacks (inline flags, POSIX classes, `\A`, `\z`).
 *  Browser-safe. */

import type { TeloFormatChecker, TeloFormatFailure } from "./telo-format.js";

/** The longest count a repetition may name — RE2's own ceiling. */
const MAX_REPEAT = 1000;

/** General_Category short names both engines read alike. `C` and `Cn` are left
 *  out: ECMAScript counts unassigned code points in `C`, RE2 has no `Cn`. */
const GENERAL_CATEGORIES: ReadonlySet<string> = new Set([
  "L", "Lu", "Ll", "Lt", "Lm", "Lo",
  "M", "Mn", "Mc", "Me",
  "N", "Nd", "Nl", "No",
  "P", "Pc", "Pd", "Ps", "Pe", "Pi", "Pf", "Po",
  "S", "Sm", "Sc", "Sk", "So",
  "Z", "Zs", "Zl", "Zp",
  "Cc", "Cf", "Cs", "Co",
]);

/** Punctuation both engines read escaped as itself, outside a class. */
const ESCAPABLE = new Set([..."^$\\.*+?()[]{}|/"]);

const CONTROL_ESCAPES = new Set([..."tnrfv"]);
const CLASS_SHORTHANDS = new Set([..."dDwW"]);
const HEX = /^[0-9A-Fa-f]{2}$/;

class Refusal extends Error {
  constructor(
    readonly reason: string,
    readonly offset: number,
  ) {
    super(reason);
  }
}

class Parser {
  private at = 0;

  constructor(private readonly text: string) {}

  parse(): void {
    this.alternation();
    if (this.at < this.text.length) {
      throw new Refusal(`unmatched ')' — escape it as \\)`, this.at);
    }
  }

  private peek(offset = 0): string | undefined {
    return this.text[this.at + offset];
  }

  private alternation(): void {
    this.concatenation();
    while (this.peek() === "|") {
      this.at++;
      this.concatenation();
    }
  }

  private concatenation(): void {
    for (;;) {
      const c = this.peek();
      if (c === undefined || c === "|" || c === ")") return;
      const start = this.at;
      const repeatable = this.atom();
      this.quantifier(start, repeatable);
    }
  }

  /** One atom; false when it is an assertion, which nothing may repeat. */
  private atom(): boolean {
    const start = this.at;
    const c = this.peek()!;
    switch (c) {
      case "^":
      case "$":
        this.at++;
        return false;
      case ".":
        throw new Refusal(
          "'.' matches a different set of characters in RE2 and ECMAScript — write the class it should match, e.g. [^\\n]",
          start,
        );
      case "(":
        this.group();
        return true;
      case "[":
        this.characterClass();
        return true;
      case "\\":
        return this.escape(false);
      case "*":
      case "+":
      case "?":
        throw new Refusal(`'${c}' has nothing to repeat`, start);
      case "{":
        throw new Refusal("a '{' that does not repeat something — escape it as \\{", start);
      case "}":
        throw new Refusal("a lone '}' — escape it as \\}", start);
      case "]":
        throw new Refusal("a lone ']' — escape it as \\]", start);
      default:
        this.at += this.text.codePointAt(this.at)! > 0xffff ? 2 : 1;
        return true;
    }
  }

  private group(): void {
    const start = this.at;
    this.at++;
    if (this.peek() === "?") {
      const next = this.peek(1);
      if (next === ":") {
        this.at += 2;
      } else if (next === "=" || next === "!") {
        throw new Refusal("lookahead is outside the format — RE2 has none", start);
      } else if (next === "<" && (this.peek(2) === "=" || this.peek(2) === "!")) {
        throw new Refusal("lookbehind is outside the format — RE2 has none", start);
      } else if (next === "<" || next === "P") {
        throw new Refusal("a named group is outside the format — write (…) or (?:…)", start);
      } else {
        throw new Refusal("an inline flag group is outside the format — ECMAScript has none", start);
      }
    }
    this.alternation();
    if (this.peek() !== ")") throw new Refusal("unclosed group — expected ')'", start);
    this.at++;
  }

  private quantifier(atomStart: number, repeatable: boolean): void {
    const c = this.peek();
    let quantified = false;
    if (c === "*" || c === "+" || c === "?") {
      this.at++;
      quantified = true;
    } else if (c === "{") {
      const start = this.at;
      const match = /^\{(\d+)(,(\d*))?\}/.exec(this.text.slice(this.at));
      if (!match) {
        throw new Refusal("a '{' that is not a repetition {n}, {n,} or {n,m} — escape it as \\{", start);
      }
      const min = Number(match[1]);
      const max = match[3] === undefined || match[3] === "" ? undefined : Number(match[3]);
      if (min > MAX_REPEAT || (max !== undefined && max > MAX_REPEAT)) {
        throw new Refusal(`a repetition count above ${MAX_REPEAT}`, start);
      }
      if (max !== undefined && max < min) {
        throw new Refusal("a repetition whose maximum is below its minimum", start);
      }
      this.at += match[0].length;
      quantified = true;
    }
    if (!quantified) return;
    if (!repeatable) throw new Refusal("an assertion cannot be repeated", atomStart);
    if (this.peek() === "?") this.at++;
    const after = this.peek();
    if (after === "*" || after === "+" || after === "?" || after === "{") {
      throw new Refusal(`'${after}' repeats a repetition`, this.at);
    }
  }

  /** An escape; inside a class `false` is never returned. */
  private escape(inClass: boolean): boolean {
    const start = this.at;
    const c = this.peek(1);
    if (c === undefined) throw new Refusal("a pattern ending in '\\'", start);
    this.at += 2;
    if (CONTROL_ESCAPES.has(c)) return true;
    if (CLASS_SHORTHANDS.has(c)) return true;
    if (c === "b" || c === "B") {
      if (inClass) throw new Refusal(`\\${c} inside a class means different things in RE2 and ECMAScript`, start);
      return false;
    }
    if (c === "x") {
      if (this.peek() === "{") throw new Refusal("\\x{…} is RE2's spelling only — write \\xHH", start);
      if (!HEX.test(this.text.slice(this.at, this.at + 2))) {
        throw new Refusal("\\x takes exactly two hexadecimal digits", start);
      }
      this.at += 2;
      return true;
    }
    if (c === "p" || c === "P") {
      if (this.peek() !== "{") throw new Refusal(`\\${c} without braces — write \\${c}{…}`, start);
      const close = this.text.indexOf("}", this.at);
      const name = close === -1 ? "" : this.text.slice(this.at + 1, close);
      if (close === -1) throw new Refusal(`unclosed \\${c}{`, start);
      if (!GENERAL_CATEGORIES.has(name)) {
        throw new Refusal(
          `\\${c}{${name}} is outside the format — only General_Category short names (L, Lu, Nd, …) are read alike`,
          start,
        );
      }
      this.at = close + 1;
      return true;
    }
    if (ESCAPABLE.has(c) || (inClass && c === "-")) return true;
    if (c === "s" || c === "S") {
      throw new Refusal(`\\${c} matches a different set of characters in RE2 and ECMAScript — write the class it should match`, start);
    }
    if (c === "u") throw new Refusal("\\u is ECMAScript's spelling only — write \\xHH or the character itself", start);
    if (c === "c") throw new Refusal("\\cX is ECMAScript's spelling only", start);
    if (c === "k") throw new Refusal("a backreference is outside the format — RE2 has none", start);
    if (c >= "1" && c <= "9") throw new Refusal("a backreference is outside the format — RE2 has none", start);
    if (c === "0") throw new Refusal("\\0 and octal escapes are outside the format — write \\xHH", start);
    if ("AzZQEC".includes(c)) throw new Refusal(`\\${c} is RE2's spelling only`, start);
    throw new Refusal(`\\${c} is not an escape both engines read alike`, start);
  }

  private characterClass(): void {
    const start = this.at;
    this.at++;
    if (this.peek() === "^") this.at++;
    if (this.peek() === "]") {
      throw new Refusal("an empty class, or a ']' first in one, is read differently by RE2 and ECMAScript — escape it as \\]", this.at);
    }
    for (;;) {
      const c = this.peek();
      if (c === undefined) throw new Refusal("unclosed class — expected ']'", start);
      if (c === "]") {
        this.at++;
        return;
      }
      const lowStart = this.at;
      const low = this.classAtom();
      if (this.peek() === "-" && this.peek(1) !== "]" && this.peek(1) !== undefined) {
        this.at++;
        const highStart = this.at;
        const high = this.classAtom();
        if (low === undefined || high === undefined) {
          throw new Refusal("a range whose end is a class, not a character", low === undefined ? lowStart : highStart);
        }
        if (high < low) throw new Refusal("a range whose end comes before its start", lowStart);
      }
    }
  }

  /** One class member: its code point, or undefined for a shorthand class. */
  private classAtom(): number | undefined {
    const start = this.at;
    const c = this.peek()!;
    if (c === "[") {
      throw new Refusal(
        this.peek(1) === ":" ? "a POSIX class is outside the format — ECMAScript has none" : "a '[' inside a class — escape it as \\[",
        start,
      );
    }
    if (c === "\\") {
      const kind = this.peek(1);
      this.escape(true);
      if (kind === undefined) return undefined;
      if (CLASS_SHORTHANDS.has(kind) || kind === "p" || kind === "P") return undefined;
      if (kind === "x") return parseInt(this.text.slice(this.at - 2, this.at), 16);
      const controls: Record<string, number> = { t: 9, n: 10, r: 13, f: 12, v: 11 };
      return controls[kind] ?? kind.codePointAt(0)!;
    }
    const point = this.text.codePointAt(this.at)!;
    this.at += point > 0xffff ? 2 : 1;
    return point;
  }
}

export const re2PatternChecker: TeloFormatChecker = {
  check(value: string): TeloFormatFailure | undefined {
    try {
      new Parser(value).parse();
      return undefined;
    } catch (error) {
      if (error instanceof Refusal) return { reason: error.reason, offset: error.offset };
      throw error;
    }
  },
};
