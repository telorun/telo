/**
 * `matches` — and it is RE2, not the host's regular expressions.
 *
 * CEL's pattern language is RE2: linear-time matching with no backreferences and no
 * lookaround. The host's own engine accepts patterns RE2 refuses and is exponential on
 * some of them, so an expression that matches here would behave differently on another
 * runtime and a hostile pattern in a manifest would be a denial of service. A pattern
 * RE2 cannot parse is `invalid_regular_expression`, never a silent `false`.
 *
 * Compilation is memoized, bounded, because a pattern is almost always a literal
 * evaluated many times. **One compile serves every caller** — the language's `matches`
 * and the catalog's regex family alike — so a pattern is read one way and the cache is
 * not duplicated; what differs is only how each words its refusal, which is why a refusal
 * answers RE2's parse-error KIND beside the library's whole message.
 */

import { RE2JS, RE2JSSyntaxException } from "re2js";
import { BoundedCache } from "./bounded-cache.js";
import { celError, type CelError } from "./cel-value.js";
import type { SourceRange } from "./syntax-tree.js";

/** How many compiled patterns one process keeps. */
export const PATTERN_CACHE_CAPACITY = 128;

/** The flag letters a caller may map onto RE2's own flags. */
export const RE2_FLAG_LETTERS: Readonly<Record<string, number>> = {
  i: RE2JS.CASE_INSENSITIVE,
  m: RE2JS.MULTILINE,
  s: RE2JS.DOTALL,
};

/**
 * RE2's parse-error kinds, in RE2's own words — the closed vocabulary an invalid-pattern
 * refusal ends with, so every engine words one identically. The last two are RE2's parser
 * limits: a nesting height above 1000, and a parsed size above 3,355,443.
 */
export const RE2_PATTERN_ERROR_KINDS: readonly string[] = [
  "missing closing )",
  "missing closing ]",
  "unexpected )",
  "trailing backslash at end of expression",
  "invalid escape sequence",
  "invalid character class range",
  "invalid named capture",
  "duplicate capture group name",
  "invalid or unsupported Perl syntax",
  "missing argument to repetition operator",
  "invalid nested repetition operator",
  "invalid repeat count",
  "expression nests too deeply",
  "expression too large",
];

/**
 * Why RE2 refused a pattern: its own parse-error kind where it reported one of the
 * closed vocabulary above, and its whole message. A caller that prints the kind decides
 * for itself what an absent one is — the language's `matches` prints the message, so a
 * refusal RE2 words some other way is still an answer about the pattern there.
 */
export interface RE2PatternRefusal {
  readonly kind?: string;
  readonly message: string;
}

export type RE2Compiled = { readonly pattern: RE2JS } | { readonly refused: RE2PatternRefusal };

const compiled = new BoundedCache<string, RE2Compiled>(PATTERN_CACHE_CAPACITY);

/** A compiled pattern, or why RE2 refused it. One compile and one cache for every caller. */
export function re2Pattern(pattern: string, flags = 0): RE2Compiled {
  const key = `${flags}\u0000${pattern}`;
  let held = compiled.get(key);
  if (held === undefined) {
    try {
      held = { pattern: RE2JS.compile(pattern, flags) };
    } catch (cause) {
      const kind = cause instanceof RE2JSSyntaxException ? cause.error : undefined;
      held = {
        refused: {
          ...(kind !== undefined && RE2_PATTERN_ERROR_KINDS.includes(kind) ? { kind } : {}),
          message: (cause as Error).message,
        },
      };
    }
    compiled.set(key, held);
  }
  return held;
}

/** Whether the pattern matches anywhere in the text, or why the pattern is not one. */
export function celMatches(text: string, pattern: string, range?: SourceRange): boolean | CelError {
  const held = re2Pattern(pattern);
  if ("refused" in held) {
    return celError(
      "invalid_regular_expression",
      `${JSON.stringify(pattern)} is not an RE2 pattern: ${held.refused.message}`,
      range,
    );
  }
  return held.pattern.matcher(text).find();
}
